# -*- coding: utf-8 -*-
"""Fuente de datos del DVIR Report para la pantalla de Avisos.

Devuelve las filas de cada hoja de empresa (`CHASER 6`, `MCC 6`...) y de la
hoja `Driver info`. Si hay credenciales de Google configuradas lee la
planilla en vivo; si no, usa el snapshot de `sample_data` (modo offline) para
poder ver la herramienta funcionando con datos reales.
"""

from . import sample_data


class ReportData:
    def __init__(self, mode: str, sheets: dict[str, list[list]],
                 driver_info: list[list], spreadsheet: str | None = None):
        self.mode = mode                  # "offline" | "live"
        self.sheets = sheets              # {nombre_hoja: filas}
        self.driver_info = driver_info    # filas de Driver info
        self.spreadsheet = spreadsheet


def _offline() -> ReportData:
    return ReportData(
        mode="offline",
        sheets={name: values for name, values in sample_data.SHEETS.items()},
        driver_info=sample_data.DRIVER_INFO,
    )


def load_report() -> ReportData:
    """Carga los datos del reporte. Por ahora siempre offline.

    Cuando se configure el Service Account, aqui se intentara leer la
    planilla en vivo y se hara fallback a offline ante cualquier error.
    """
    try:
        from . import gsheets  # noqa: F401  (modulo opcional, aun no activo)
        live = gsheets.try_load_live()
        if live is not None:
            return live
    except Exception:  # noqa: BLE001  - cualquier fallo => offline
        pass
    return _offline()
