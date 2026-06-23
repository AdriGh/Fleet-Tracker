# -*- coding: utf-8 -*-
"""Tests de SEC-3: rate limiting, baneo de IP y bloqueo de cuenta.

Corre con pytest (`python -m pytest backend/tests/test_ratelimit.py`) o como
script suelto (`python backend/tests/test_ratelimit.py`) — hoy pytest no esta
instalado, asi que el bloque __main__ ejecuta cada test con asserts.

Para que los umbrales sean chicos y deterministas, se setean las ENV VAR de
SEC-3 ANTES de importar el modulo (que las lee a nivel modulo) y se recarga.
"""

import importlib
import os
import sys
from pathlib import Path

# Permite `import app.core.ratelimit` corriendo el archivo directo.
_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# Limites de prueba (chicos): rate 3/ventana, ban tras 4 fallos, lockout tras 3.
os.environ.update({
    "SEC3_LOGIN_RATE": "3",
    "SEC3_LOGIN_RATE_WINDOW_S": "60",
    "SEC3_SETUP_RATE": "3",
    "SEC3_SETUP_RATE_WINDOW_S": "60",
    "SEC3_IP_FAIL_MAX": "4",
    "SEC3_IP_FAIL_WINDOW_S": "600",
    "SEC3_IP_BAN_S": "900",
    "SEC3_ACCT_FAIL_MAX": "3",
    "SEC3_ACCT_FAIL_WINDOW_S": "600",
    "SEC3_ACCT_LOCK_S": "900",
})

from app.core import ratelimit  # noqa: E402
importlib.reload(ratelimit)     # re-lee las env var de arriba


class _FakeRequest:
    """Stub minimo: solo headers + .client.host, como un Starlette Request."""
    class _Client:
        def __init__(self, host):
            self.host = host

    def __init__(self, headers=None, host="10.0.0.1"):
        # headers case-insensitive (como Starlette): clave en minuscula.
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}
        self.client = self._Client(host)


def setup_function(_=None):
    # pytest llama setup_function antes de cada test; el runner manual tambien.
    ratelimit._reset_all()


def test_rate_limit_excede_en_n_mas_1():
    # limit=3 -> los 3 primeros pasan (True), el 4to excede (False).
    assert ratelimit.hit("k", 3, 60) is True
    assert ratelimit.hit("k", 3, 60) is True
    assert ratelimit.hit("k", 3, 60) is True
    assert ratelimit.hit("k", 3, 60) is False, "el N+1 debe exceder"
    # Una key distinta tiene su propio contador.
    assert ratelimit.hit("otra", 3, 60) is True


def test_ban_de_ip_tras_umbral():
    ip = "203.0.113.7"
    banned, left = ratelimit.is_banned(ip)
    assert banned is False and left == 0
    # IP_FAIL_MAX=4: a los 4 fallos queda baneada.
    for _ in range(4):
        ratelimit.record_failure(ip)
    banned, left = ratelimit.is_banned(ip)
    assert banned is True, "tras 4 fallos la IP debe quedar baneada"
    assert left > 0, "debe reportar segundos restantes del ban"
    # Un exito limpia el contador de fallos (no des-banea, pero resetea cuenta).
    other = "203.0.113.8"
    ratelimit.record_failure(other)
    ratelimit.record_success(other)
    banned2, _ = ratelimit.is_banned(other)
    assert banned2 is False


def test_lockout_de_cuenta():
    user = "Admin"  # se normaliza a 'admin'
    locked, left = ratelimit.is_locked(user)
    assert locked is False and left == 0
    # ACCT_FAIL_MAX=3: al 3er fallo se bloquea la cuenta.
    for _ in range(3):
        ratelimit.record_account_failure(user)
    locked, left = ratelimit.is_locked("  admin ")  # mismo normalizado
    assert locked is True, "tras 3 fallos la cuenta debe quedar bloqueada"
    assert left > 0
    # Otra cuenta no se ve afectada.
    locked_other, _ = ratelimit.is_locked("viewer")
    assert locked_other is False
    # Exito limpia el contador (probamos en una cuenta que aun no bloquea).
    ratelimit.record_account_failure("dispatcher")
    ratelimit.record_account_success("dispatcher")
    ratelimit.record_account_failure("dispatcher")
    locked_d, _ = ratelimit.is_locked("dispatcher")
    assert locked_d is False, "el exito debe haber reseteado el contador"


def test_client_ip_parsea_xff():
    # XFF con varias IPs: toma la PRIMERA (cliente original), no el proxy.
    req = _FakeRequest(
        headers={"X-Forwarded-For": "198.51.100.5, 10.0.0.2, 10.0.0.3"},
        host="172.16.0.1")
    assert ratelimit.client_ip(req) == "198.51.100.5"
    # Sin XFF: cae a request.client.host.
    req2 = _FakeRequest(headers={}, host="172.16.0.9")
    assert ratelimit.client_ip(req2) == "172.16.0.9"
    # XFF con una sola IP.
    req3 = _FakeRequest(headers={"X-Forwarded-For": "  192.0.2.44  "})
    assert ratelimit.client_ip(req3) == "192.0.2.44"


def _run_standalone():
    tests = [
        test_rate_limit_excede_en_n_mas_1,
        test_ban_de_ip_tras_umbral,
        test_lockout_de_cuenta,
        test_client_ip_parsea_xff,
    ]
    failed = 0
    for t in tests:
        setup_function()
        try:
            t()
            print(f"PASS  {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL  {t.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"ERROR {t.__name__}: {type(exc).__name__}: {exc}")
    total = len(tests)
    print(f"\n{total - failed}/{total} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_standalone())
