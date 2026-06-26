# -*- coding: utf-8 -*-
"""Rate limiting, baneo de IP y bloqueo de cuenta (SEC-3).

Defensa contra fuerza bruta / credential stuffing en los endpoints de auth.
Tres capas que se complementan:

  1. Rate limit por ventana deslizante (login: 5/min por IP) — frena el ritmo.
  2. Baneo de IP: tras ~15 fallos en 10 min, la IP queda baneada 15 min —
     frena a un atacante desde una sola IP.
  3. Bloqueo de cuenta por username: tras ~8 fallos de una misma cuenta, esa
     cuenta queda bloqueada 15 min — frena ataques DISTRIBUIDOS (muchas IPs
     contra una sola cuenta) que el ban por IP no ve.

IMPLEMENTACION EN MEMORIA, a proposito: hoy la app corre con UNA sola replica
detras de Traefik (ya hay stores en memoria, p.ej. `_jobs` en routes.py), asi
que un store de proceso es consistente y sin dependencias nuevas pesadas. El
upgrade para multi-replica es **redis** (un contador/TTL compartido) — eso es
ARCH-1; mientras tanto esto es suficiente y simple. Thread-safe con
`threading.Lock` porque uvicorn sirve sobre un pool de threads.

Limites configurables por ENV VAR (defaults sanos entre parentesis):
  - SEC3_LOGIN_RATE        login: peticiones por ventana / IP   (5)
  - SEC3_LOGIN_RATE_WINDOW_S  ventana del rate limit en segundos (60)
  - SEC3_SETUP_RATE        setup: peticiones por ventana / IP   (5)
  - SEC3_SETUP_RATE_WINDOW_S  ventana del rate limit de setup    (60)
  - SEC3_SCAN_RATE         escaneo AI: peticiones/ventana / usuario (15)
  - SEC3_SCAN_RATE_WINDOW_S  ventana del rate limit de escaneo      (60)
  - SEC3_SCAN_DAILY        escaneo AI: tope diario / usuario        (150)
  - SEC3_SCAN_DAILY_WINDOW_S ventana del tope diario (segundos)     (86400)
  - SEC3_IP_FAIL_MAX       fallos de login por IP para banear   (15)
  - SEC3_IP_FAIL_WINDOW_S  ventana en que se cuentan esos fallos (600)
  - SEC3_IP_BAN_S          duracion del ban de IP en segundos    (900)
  - SEC3_ACCT_FAIL_MAX     fallos de una cuenta para bloquearla  (8)
  - SEC3_ACCT_FAIL_WINDOW_S ventana de los fallos de cuenta      (600)
  - SEC3_ACCT_LOCK_S       duracion del bloqueo de cuenta        (900)
"""

from __future__ import annotations

import os
import threading
import time

# ----- Configuracion (env var con defaults sanos) ------------------------


def _env_int(name: str, default: int) -> int:
    # Defensivo: una env var corrupta cae al default en vez de tumbar la app.
    raw = os.environ.get(name, "")
    try:
        val = int(raw)
        return val if val > 0 else default
    except (TypeError, ValueError):
        return default


LOGIN_RATE = _env_int("SEC3_LOGIN_RATE", 5)
LOGIN_RATE_WINDOW_S = _env_int("SEC3_LOGIN_RATE_WINDOW_S", 60)
SETUP_RATE = _env_int("SEC3_SETUP_RATE", 5)
SETUP_RATE_WINDOW_S = _env_int("SEC3_SETUP_RATE_WINDOW_S", 60)
# Escaneo AI (Groq): limite POR USUARIO. El escaneo consume el key COMPARTIDO
# de Groq (free tier ~125/dia); sin limite un usuario agotaria la cuota -> 429
# para TODOS. Defaults generosos para el piloto (15/min, 150/dia).
SCAN_RATE = _env_int("SEC3_SCAN_RATE", 15)
SCAN_RATE_WINDOW_S = _env_int("SEC3_SCAN_RATE_WINDOW_S", 60)
SCAN_DAILY = _env_int("SEC3_SCAN_DAILY", 150)
SCAN_DAILY_WINDOW_S = _env_int("SEC3_SCAN_DAILY_WINDOW_S", 86400)

IP_FAIL_MAX = _env_int("SEC3_IP_FAIL_MAX", 15)
IP_FAIL_WINDOW_S = _env_int("SEC3_IP_FAIL_WINDOW_S", 600)
IP_BAN_S = _env_int("SEC3_IP_BAN_S", 900)

ACCT_FAIL_MAX = _env_int("SEC3_ACCT_FAIL_MAX", 8)
ACCT_FAIL_WINDOW_S = _env_int("SEC3_ACCT_FAIL_WINDOW_S", 600)
ACCT_LOCK_S = _env_int("SEC3_ACCT_LOCK_S", 900)


# ----- Estado en memoria (protegido por _LOCK) ---------------------------

_LOCK = threading.Lock()
# key -> lista de timestamps de los hits dentro de la ventana.
_hits: dict[str, list[float]] = {}
# ip -> lista de timestamps de fallos de login dentro de la ventana.
_ip_fails: dict[str, list[float]] = {}
# ip -> epoch hasta el que esta baneada.
_ip_bans: dict[str, float] = {}
# username -> lista de timestamps de fallos de esa cuenta.
_acct_fails: dict[str, list[float]] = {}
# username -> epoch hasta el que la cuenta esta bloqueada.
_acct_locks: dict[str, float] = {}

# Limpieza perezosa: cada cuantos segundos barrer entradas viejas/expiradas
# para que los dicts no crezcan sin limite (sin un thread aparte).
_CLEAN_EVERY_S = 300
_last_clean = 0.0


def _prune_locked(now: float) -> None:
    """Barre entradas expiradas. DEBE llamarse con _LOCK tomado."""
    global _last_clean
    if now - _last_clean < _CLEAN_EVERY_S:
        return
    _last_clean = now
    horizon = max(LOGIN_RATE_WINDOW_S, SETUP_RATE_WINDOW_S, SCAN_DAILY_WINDOW_S,
                  IP_FAIL_WINDOW_S, ACCT_FAIL_WINDOW_S)
    for store in (_hits, _ip_fails, _acct_fails):
        for k in list(store.keys()):
            store[k] = [t for t in store[k] if now - t < horizon]
            if not store[k]:
                del store[k]
    for store in (_ip_bans, _acct_locks):
        for k in list(store.keys()):
            if store[k] <= now:
                del store[k]


# ----- IP del cliente real -----------------------------------------------

def client_ip(request) -> str:
    """IP real del cliente.

    CRITICO: la app corre detras de Traefik (Dokploy). `request.client.host`
    es la IP INTERNA del proxy (la misma para todos), asi que limitar por ahi
    seria un limite GLOBAL e inutil — un atacante consumiria la cuota de todos.
    Traefik setea `X-Forwarded-For: <cliente>, <proxy1>, ...`; la PRIMERA IP de
    la lista es el cliente original. Caemos a `request.client.host` solo si no
    hay header (p.ej. en tests o acceso directo al puerto 8000, que no se
    publica afuera).
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    client = getattr(request, "client", None)
    return client.host if client and client.host else "unknown"


# ----- Rate limiter de ventana deslizante --------------------------------

def hit(key: str, limit: int, window_s: int) -> bool:
    """Registra un hit para `key`. Devuelve True si esta DENTRO del limite
    (<= limit en la ventana), False si lo excede. La ventana es deslizante:
    descarta los timestamps mas viejos que `window_s`."""
    now = time.time()
    with _LOCK:
        _prune_locked(now)
        stamps = [t for t in _hits.get(key, []) if now - t < window_s]
        stamps.append(now)
        _hits[key] = stamps
        return len(stamps) <= limit


# ----- Baneo de IP por fallos de login -----------------------------------

def is_banned(ip: str) -> tuple[bool, int]:
    """¿La IP esta baneada? Devuelve (baneada, segundos_restantes)."""
    now = time.time()
    with _LOCK:
        until = _ip_bans.get(ip)
        if until and until > now:
            return True, int(until - now) + 1
        if until:  # ban expirado: limpiar
            _ip_bans.pop(ip, None)
        return False, 0


def record_failure(ip: str) -> None:
    """Registra un fallo de login para la IP. Si supera el umbral en la
    ventana, banea la IP por IP_BAN_S."""
    now = time.time()
    with _LOCK:
        _prune_locked(now)
        fails = [t for t in _ip_fails.get(ip, [])
                 if now - t < IP_FAIL_WINDOW_S]
        fails.append(now)
        _ip_fails[ip] = fails
        if len(fails) >= IP_FAIL_MAX:
            _ip_bans[ip] = now + IP_BAN_S
            _ip_fails.pop(ip, None)  # reset del contador tras banear


def record_success(ip: str) -> None:
    """Login exitoso: limpia el contador de fallos de la IP."""
    with _LOCK:
        _ip_fails.pop(ip, None)


# ----- Bloqueo de cuenta por username ------------------------------------

def _norm_user(username: str) -> str:
    # Mismo normalizado que auth.login (strip + lower) para que el contador
    # case por la cuenta real y no por la grafia exacta del intento.
    return (username or "").strip().lower()


def is_locked(username: str) -> tuple[bool, int]:
    """¿La cuenta esta bloqueada? Devuelve (bloqueada, segundos_restantes)."""
    user = _norm_user(username)
    now = time.time()
    with _LOCK:
        until = _acct_locks.get(user)
        if until and until > now:
            return True, int(until - now) + 1
        if until:
            _acct_locks.pop(user, None)
        return False, 0


def record_account_failure(username: str) -> None:
    """Registra un fallo para la cuenta. Si supera el umbral en la ventana,
    bloquea esa cuenta por ACCT_LOCK_S (complementa el ban por IP ante
    ataques distribuidos)."""
    user = _norm_user(username)
    if not user:
        return
    now = time.time()
    with _LOCK:
        _prune_locked(now)
        fails = [t for t in _acct_fails.get(user, [])
                 if now - t < ACCT_FAIL_WINDOW_S]
        fails.append(now)
        _acct_fails[user] = fails
        if len(fails) >= ACCT_FAIL_MAX:
            _acct_locks[user] = now + ACCT_LOCK_S
            _acct_fails.pop(user, None)


def record_account_success(username: str) -> None:
    """Login exitoso: limpia el contador de fallos de la cuenta."""
    user = _norm_user(username)
    with _LOCK:
        _acct_fails.pop(user, None)


# ----- Helpers de test / mantenimiento -----------------------------------

def _reset_all() -> None:
    """Limpia TODO el estado. Solo para tests (aislar casos)."""
    global _last_clean
    with _LOCK:
        _hits.clear()
        _ip_fails.clear()
        _ip_bans.clear()
        _acct_fails.clear()
        _acct_locks.clear()
        _last_clean = 0.0
