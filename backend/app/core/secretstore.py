"""Abstraccion de secretos (H6 fase 3d).

Los secretos (secreto de firma de tokens, tokens de Samsara/Google, api_keys
de LLM) NO van a la base ni al repo. Esta capa los lee/escribe detras de una
interfaz para que H8 (hosting) enchufe un secrets manager real (AWS Secrets
Manager, etc.) sin tocar a los consumidores.

Backend por defecto: FileSecretStore, que mantiene el comportamiento actual
(archivos backend/<name>.local.json, gitignored). El backend se elige por la
variable de entorno SECRETS_BACKEND (por ahora solo 'file').

Los secretos se manejan como un blob JSON por `name` (= el nombre del archivo
legacy sin extension: 'secret', 'google', 'samsara', 'docscan'...), igual que
hoy. El parametro org_id queda en la interfaz para secretos por-tenant a
futuro; el backend de archivos lo ignora (single-tenant = global)."""

from __future__ import annotations

import abc
import json
import os
from pathlib import Path

from .. import config


class SecretStore(abc.ABC):
    @abc.abstractmethod
    def get_blob(self, name: str, org_id: int | None = None) -> dict:
        """Blob (dict) del secreto `name`, o {} si no existe."""

    @abc.abstractmethod
    def set_blob(self, name: str, data: dict,
                 org_id: int | None = None) -> None:
        """Persiste el blob del secreto `name`."""


class FileSecretStore(SecretStore):
    """Cada secreto en <base>/<name>.local.json. Por ahora global: org_id
    se ignora. Es el comportamiento historico, intacto.

    `base` por defecto es backend/ (dev local, sin cambios). En contenedores
    se puede apuntar a un directorio montado con los secretos via la env
    FLEET_SECRETS_DIR (p.ej. /app/secrets), asi NO hace falta bind-montear
    cada *.local.json individual sobre /app/backend (ver docker-compose.yml /
    DEPLOY.md). Si FLEET_SECRETS_DIR no esta seteada, se usa backend/."""

    def __init__(self, base: Path | None = None):
        if base is None:
            env_dir = os.environ.get("FLEET_SECRETS_DIR", "").strip()
            base = Path(env_dir) if env_dir else config.BACKEND_DIR
        self._base = base

    def _path(self, name: str) -> Path:
        return self._base / f"{name}.local.json"

    def get_blob(self, name: str, org_id: int | None = None) -> dict:
        p = self._path(name)
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
            except (OSError, ValueError):
                pass
        return {}

    def set_blob(self, name: str, data: dict,
                 org_id: int | None = None) -> None:
        self._path(name).write_text(
            json.dumps(data), encoding="utf-8")


_BACKENDS = {"file": FileSecretStore}
_store: SecretStore | None = None


def store() -> SecretStore:
    """Singleton del backend de secretos elegido por SECRETS_BACKEND."""
    global _store
    if _store is None:
        backend = os.environ.get("SECRETS_BACKEND", "file")
        _store = _BACKENDS.get(backend, FileSecretStore)()
    return _store
