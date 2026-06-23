# -*- coding: utf-8 -*-
"""Autenticación real (fase G7): usuarios, roles y tokens firmados.

- Contraseñas: pbkdf2-sha256, 200k iteraciones, salt por usuario.
- Tokens: stateless, firmados con HMAC-SHA256. Payload =
  "user_id.expiry_epoch"; el secreto vive en `backend/secret.local.json`
  (se autogenera la primera vez; gitignored). Reiniciar el server NO
  invalida sesiones; rotar el secreto sí.
- Roles: admin · dispatcher · mechanic · viewer. El enforcement de
  rutas vive en el middleware de main.py.

Cifrado en reposo de credenciales de integraciones: pendiente G7.2
(keyring/DPAPI) — para una app local single-box el modelo de amenaza
lo permite.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from datetime import datetime

from sqlalchemy import func, select

from ..db import SessionLocal, User, default_org_id
from . import secretstore, tenant

# H4: 'safety' (cumplimiento: DVIR/PM/DOT, avisos, PII) sumado al set.
ROLES = ("admin", "dispatcher", "safety", "mechanic", "viewer")
TOKEN_TTL_S = 30 * 24 * 3600          # 30 días
_PBKDF2_ITERS = 200_000


def _secret() -> bytes:
    # H6 fase 3d: el secreto de firma vive detras de SecretStore (backend de
    # archivos por defecto: backend/secret.local.json). H8 puede enchufar un
    # secrets manager sin tocar esto. Es global (no por-tenant).
    blob = secretstore.store().get_blob("secret")
    s = blob.get("auth_secret", "")
    if s:
        try:
            return bytes.fromhex(s)
        except ValueError:
            pass
    raw = secrets.token_bytes(32)
    secretstore.store().set_blob("secret", {"auth_secret": raw.hex()})
    return raw


# ----- Contraseñas -------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 salt, _PBKDF2_ITERS)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split("$", 1)
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"),
            bytes.fromhex(salt_hex), _PBKDF2_ITERS)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


# ----- Tokens ------------------------------------------------------------

def issue_token(user_id: int) -> str:
    payload = f"{user_id}.{int(time.time()) + TOKEN_TTL_S}"
    sig = hmac.new(_secret(), payload.encode("ascii"),
                   hashlib.sha256).hexdigest()
    b64 = base64.urlsafe_b64encode(payload.encode("ascii")).decode("ascii")
    return f"{b64}.{sig}"


def verify_token(token: str) -> dict | None:
    """Devuelve el usuario del token (dict) o None si es inválido."""
    try:
        b64, sig = token.split(".", 1)
        payload = base64.urlsafe_b64decode(b64.encode("ascii")) \
            .decode("ascii")
    except (ValueError, UnicodeDecodeError):
        return None
    want = hmac.new(_secret(), payload.encode("ascii"),
                    hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, want):
        return None
    try:
        user_id_s, expiry_s = payload.split(".", 1)
        if int(expiry_s) < time.time():
            return None
        user_id = int(user_id_s)
    except ValueError:
        return None
    with SessionLocal() as session:
        u = session.get(User, user_id)
        if u is None or not u.active:
            return None
        return {"id": u.id, "username": u.username, "name": u.name,
                "role": u.role, "org_id": u.org_id}


def user_from_header(authorization: str | None) -> dict | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return verify_token(authorization[7:].strip())


# ----- Usuarios ----------------------------------------------------------

def users_exist() -> bool:
    with SessionLocal() as session:
        return bool(session.scalar(
            select(func.count()).select_from(User)))


def create_user(name: str, username: str, password: str,
                role: str = "viewer", org_id: int | None = None) -> dict:
    username = username.strip().lower()
    name = name.strip()
    if not username or not password:
        raise ValueError("username and password are required")
    if len(password) < 8:
        raise ValueError("password needs at least 8 characters")
    if role not in ROLES:
        role = "viewer"
    # H6 fase 3: el usuario pertenece a una organizacion (tenant). En el modo
    # single-tenant actual cae en la org 'default'.
    if org_id is None:
        org_id = default_org_id()
    with SessionLocal() as session:
        if session.scalar(select(User).where(
                User.username == username)):
            raise ValueError(f"user '{username}' already exists")
        u = User(username=username[:40], name=name[:120], role=role,
                 org_id=org_id,
                 pw_hash=hash_password(password), active=True,
                 created_at=datetime.now())
        session.add(u)
        session.commit()
        return {"id": u.id, "username": u.username, "name": u.name,
                "role": u.role, "active": u.active, "org_id": u.org_id}


def setup_admin(name: str, username: str, password: str) -> dict:
    """Crea el PRIMER usuario (admin). Solo válido con la tabla vacía."""
    if users_exist():
        raise ValueError("the app already has users")
    return create_user(name, username, password, role="admin")


def login(username: str, password: str) -> dict | None:
    username = username.strip().lower()
    with SessionLocal() as session:
        u = session.scalar(select(User).where(
            User.username == username))
        if u is None or not u.active \
                or not verify_password(password, u.pw_hash):
            # Coste fijo ante usuario inexistente (timing uniforme).
            if u is None:
                verify_password(password, hash_password("x" * 12))
            return None
        return {"token": issue_token(u.id),
                "user": {"id": u.id, "username": u.username,
                         "name": u.name, "role": u.role,
                         "org_id": u.org_id}}


def list_users() -> list[dict]:
    # DATA-3 (IDOR): User NO es OrgScoped, así que sus SELECT no se filtran
    # solos. Filtramos por la org del request para no listar usuarios de otra
    # organización. (Single-tenant: no-op; multi-tenant: aislamiento correcto.)
    org = tenant.get_current_org()
    with SessionLocal() as session:
        q = select(User).order_by(User.id)
        if org is not None:
            q = q.where(User.org_id == org)
        return [{
            "id": u.id, "username": u.username, "name": u.name,
            "role": u.role, "active": u.active,
            "created_at": u.created_at.isoformat(),
        } for u in session.scalars(q).all()]


def update_user(user_id: int, fields: dict,
                acting_admin_id: int) -> dict | None:
    with SessionLocal() as session:
        u = session.get(User, user_id)
        if u is None:
            return None
        # DATA-3 (IDOR): el target debe pertenecer a la org del admin actuante;
        # si no, se trata como inexistente (no se modifica nada cross-tenant).
        org = tenant.get_current_org()
        if org is not None and u.org_id != org:
            return None
        if "role" in fields and fields["role"] in ROLES:
            u.role = fields["role"]
        if "active" in fields:
            # Un admin no puede desactivarse a sí mismo (lockout).
            if not fields["active"] and u.id == acting_admin_id:
                raise ValueError("you can't deactivate your own account")
            u.active = bool(fields["active"])
        if fields.get("password"):
            if len(str(fields["password"])) < 8:
                raise ValueError(
                    "password needs at least 8 characters")
            u.pw_hash = hash_password(str(fields["password"]))
        if "name" in fields:
            u.name = str(fields["name"]).strip()[:120]
        session.commit()
        return {"id": u.id, "username": u.username, "name": u.name,
                "role": u.role, "active": u.active}
