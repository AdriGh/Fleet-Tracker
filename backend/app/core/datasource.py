# -*- coding: utf-8 -*-
"""Fuente de datos del DVIR Report para la pantalla de Avisos.

Devuelve las filas de cada hoja de empresa (`CHASER 6`, `MCC 6`...) y de la
hoja `Driver info`. Si hay credenciales de Google configuradas en
`avisos.local.json`, lee la planilla en vivo; si no (o si la lectura falla),
usa el snapshot de `sample_data` (modo offline) para poder ver la herramienta
funcionando con datos reales.
"""

from . import gsheets, local_config, sample_data


class ReportData:
    def __init__(self, mode: str, sheets: dict[str, list[list]],
                 driver_info: list[list], spreadsheet: str | None = None,
                 live_error: str = ""):
        self.mode = mode                  # "offline" | "live"
        self.sheets = sheets              # {nombre_hoja: filas}
        self.driver_info = driver_info    # filas de Driver info
        self.spreadsheet = spreadsheet
        self.live_error = live_error      # motivo si se quiso live y fallo


def _offline(live_error: str = "") -> ReportData:
    return ReportData(
        mode="offline",
        sheets=dict(sample_data.SHEETS),
        driver_info=sample_data.DRIVER_INFO,
        live_error=live_error,
    )


def load_report() -> ReportData:
    """Carga los datos del reporte: en vivo si esta configurado, si no offline."""
    cfg = local_config.load()
    if not gsheets.is_configured(cfg):
        return _offline()
    try:
        return gsheets.load_live(cfg)
    except Exception as exc:  # noqa: BLE001
        # Configurado pero fallo: se sigue en offline, pero se reporta el
        # motivo para mostrarlo en la pantalla de Avisos.
        return _offline(live_error=f"{type(exc).__name__}: {exc}")
