# -*- coding: utf-8 -*-
"""Hosting público de media para MMS / links de SMS (Cloudinary).

Twilio MMS necesita una **URL pública** del archivo; la app corre local
(127.0.0.1), así que el media se sube a Cloudinary y se usa esa URL. Cloudinary
free-tier maneja imágenes y video y devuelve `secure_url`.

Config en `backend/cloudinary.local.json` (gitignored por `*.local.json`):
    {
      "cloud_name": "tu-cloud",
      "api_key": "1234567890",
      "api_secret": "xxxxxxxx",
      "dry_run": true
    }

Si falta o está en `dry_run`, devuelve una URL ficticia (para previsualizar el
flujo sin subir nada).
"""

import hashlib
import json
import time
from pathlib import Path

import httpx

SETTINGS_PATH = Path(__file__).resolve().parents[2] / "cloudinary.local.json"
_TIMEOUT = 60


class MediaSettings:
    def __init__(self, data: dict):
        self.cloud_name = str(data.get("cloud_name", "")).strip()
        self.api_key = str(data.get("api_key", "")).strip()
        self.api_secret = str(data.get("api_secret", "")).strip()
        self.dry_run = bool(data.get("dry_run", True))

    @property
    def configured(self) -> bool:
        return bool(self.cloud_name and self.api_key and self.api_secret)


def load_settings() -> MediaSettings:
    if SETTINGS_PATH.exists():
        try:
            return MediaSettings(
                json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    return MediaSettings({})


def _resource_type(mime: str) -> str:
    if (mime or "").startswith("video/"):
        return "video"
    if (mime or "").startswith("image/"):
        return "image"
    return "raw"


def _sign(params: dict, api_secret: str) -> str:
    """Firma SHA1 de Cloudinary: params ordenados + api_secret."""
    to_sign = "&".join(f"{k}={params[k]}" for k in sorted(params))
    return hashlib.sha1((to_sign + api_secret).encode("utf-8")).hexdigest()


def upload(content: bytes, mime: str, filename: str) -> dict:
    """Sube un archivo a Cloudinary. Devuelve {ok, url, resource_type, error,
    simulated}. En dry_run devuelve una URL ficticia."""
    settings = load_settings()
    rtype = _resource_type(mime)
    if settings.dry_run or not settings.configured:
        return {"ok": True, "simulated": True, "error": "",
                "url": f"https://example.com/dryrun/{rtype}/{filename}",
                "resource_type": rtype}
    try:
        ts = int(time.time())
        signature = _sign({"timestamp": ts}, settings.api_secret)
        url = (f"https://api.cloudinary.com/v1_1/{settings.cloud_name}"
               f"/{rtype}/upload")
        data = {"api_key": settings.api_key, "timestamp": str(ts),
                "signature": signature}
        files = {"file": (filename, content, mime)}
        r = httpx.post(url, data=data, files=files, timeout=_TIMEOUT)
        r.raise_for_status()
        body = r.json()
        return {"ok": True, "simulated": False, "error": "",
                "url": body.get("secure_url", ""), "resource_type": rtype}
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text
        try:
            detail = exc.response.json()["error"]["message"]
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "simulated": False, "error": detail,
                "url": "", "resource_type": rtype}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "simulated": False, "error": str(exc),
                "url": "", "resource_type": rtype}
