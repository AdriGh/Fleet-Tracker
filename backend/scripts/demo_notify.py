# -*- coding: utf-8 -*-
"""Validacion de la logica de Avisos contra datos reales del DVIR Report.

Ejecutar desde backend/:   py scripts/demo_notify.py

Usa los bloques reales 6.1/6.2 de CHASER y 6.1 de MCC (leidos de Drive) y la
hoja `Driver info` real (sin la columna Truck# todavia, asi que la region se
deduce como respaldo de la unidad del propio bloque). NO envia correos.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.contacts import parse_contacts          # noqa: E402
from app.core.notify import build_notices, render_email  # noqa: E402
from app.core.sheet_report import parse_blocks         # noqa: E402

# --- Bloques reales (Company, Driver, Trk#, DVIR, Trl#, DVIR Trl,
#                      Duration trk, Duration trl, Distance) ----------------
M = ""  # celda vacia, por brevidad

CHASER_6 = [
    ["Company", "Driver", "Trk#", "DVIR", "Trl#", "DVIR Trl",
     "Duration trk", "Duration trl", "Distance (mi)"],
    ["6.1"],
    ["CHASER", "John Samuels", "CF2248", "Safe", "-", "-", "15m 56s", "-", "321.1"],
    ["CHASER", "Cedric Dorsey", "CF2250", "Safe", "867667", "Unsafe", "5m 31s", "7m 21s", "454.5"],
    ["CHASER", "Shawn Dempsey", "CF2251", "Safe", "-", "-", "34m 27s", "-", "431.9"],
    ["CHASER", "David Barren", "CI2037", "Safe", "558330", "Safe", "17m 40s", "12m", "434.9"],
    ["CHASER", "Robert Lotz", "CI2242", "Safe", "429005", "Safe", "7m 34s", "5m 12s", "284.9"],
    ["CHASER", "Christiaan Zeeuw", "CI2244", "Safe", "620276", "Safe", "14m 12s", "16s", "736.3"],
    ["CHASER", "Keith Crawford", "CF2254", "⚠ NO DVIR", M, M, M, M, "126.8"],
    ["6.2"],
    ["CHASER", "Earl Stockton", "CF2246", "Safe", "429015", "Safe", "18m 22s", "6m 40s", "407.5"],
    [M, M, M, M, "743451", "Safe", M, "28m 16s", M],
    ["CHASER", "John Samuels", "CF2248", "Safe", "-", "-", "43m 30s", "-", "226.5"],
    ["CHASER", "Cedric Dorsey", "CF2250", "Safe", "620306", "Safe", "4m 11s", "2m 35s", "289.6"],
    ["CHASER", "Shawn Dempsey", "CF2251", "Safe", "-", "-", "30m 19s", "-", "287.5"],
    ["CHASER", "Victor Bingue", "CF2253", "Resolved", "880419", "Safe", "4m 59s", "2m 57s", "11.4"],
    ["CHASER", "Keith Crawford", "CF2254", "Resolved", "867669", "Safe", "13m 11s", "8m 57s", "470.9"],
    ["CHASER", "Julio Hernandez", "CI2036", "Resolved", "743449", "Resolved", "9m 39s", "14m 5s", "10.3"],
    ["CHASER", "David Barren", "CI2037", "Safe", "-", "-", "17m 35s", "-", "469.1"],
    ["CHASER", "Robert Lotz", "CI2242", "Safe", "429005", "Safe", "8m 51s", "10m 20s", "367"],
    ["CHASER", M, M, M, "558696", "Unsafe", M, "16m 40s", M],
    ["CHASER", "Christiaan Zeeuw", "CI2244", "Safe", "277188", "Safe", "17m 27s", "12s", "454.3"],
    ["CHASER", M, M, M, "620276", "Safe", M, "20s", M],
]

MCC_6 = [
    ["Company", "Driver", "Trk#", "DVIR", "Trl#", "DVIR Trl",
     "Duration trk", "Duration trl", "Distance (mi)"],
    ["6.1"],
    ["MCC", "MICHEAL JOHNSON", "ATL-CI2243", "Safe", "-", "-", "7m 7s", "-", "361.2"],
    ["MCC", "PATRICK WELLS", "CI2033", "Safe", "-", "-", "10s", "-", "402.1"],
    ["MCC", "Chris Dotson", "MDW-2019109", "Safe", "-", "-", "5m 4s", "-", "516"],
    ["MCC", "Reginald Robertson", "MDW-373", "Safe", "Cell 690967", "Safe", "1m 55s", "14s", "231.8"],
    [M, M, M, M, "XYZZ 204185", "Safe", M, "24s", M],
    [M, M, M, M, "XYZZ 333503", "Safe", M, "35s", M],
    ["MCC", "Edwin Viteri", "MDW-CF1663", "Safe", "-", "-", "2s", "-", "77.1"],
    ["MCC", M, "MDW-CF1846", "Safe", "-", "-", "2s", "-", "369"],
    ["MCC", "Kevin Newsome", "MDW-CF1847", "Safe", "-", "-", "15s", "-", "386.4"],
    ["MCC", "Joseph Zabinski", "MDW-CF1849", "Safe", "-", "-", "21s", "-", "464.2"],
    ["MCC", "Deshario Gates", "MEM-CI1921", "Safe", "-", "-", "9s", "-", "389.2"],
    ["MCC", "Michael Parham", "MEM-CK20105", "Safe", "-", "-", "1m 22s", "-", "179.5"],
    ["MCC", "Jimmone Jones", "MEM-RMF1821", "Safe", "-", "-", "30s", "-", "191.7"],
    ["MCC", "John Hawkins", "MEM-RMF1824", "Safe", "-", "-", "36m 48s", "-", "378.6"],
    ["MCC", "Melvin Tyms", "MEM-RMF1826", "Safe", "-", "-", "16s", "-", "113.4"],
    ["MCC", "Everick Morris", "MEM-RMF1829", "Safe", "-", "-", "38s", "-", "134.6"],
    ["MCC", "Marvin Clinton", "MEM-RMI1703", "Safe", "-", "-", "38s", "-", "226.7"],
    ["MCC", "Jarrod Snell", "MEM-RMO0035", "Safe", "-", "-", "22s", "-", "76.4"],
    ["MCC", "Johnny Pickens", "MEM-RMO0066", "Safe", "-", "-", "1h 25m 47s", "-", "125"],
    ["MCC", "Clayton Mabon", "MEM-RMO0093", "Safe", "TCLU673527 0", "Safe", "20s", "20s", "216.4"],
    ["MCC", "Ahmad Alhindi", "MEM-RMO0096", "Safe", "-", "-", "16s", "-", "144.5"],
    ["MCC", "Joe Teague", "MEM-RMO0104", "Safe", "-", "-", "4m 36s", "-", "106.9"],
    ["MCC", "Alonzo Starks", "MEM-RMO0117", "Safe", "-", "-", "42m 25s", "-", "173.8"],
    ["MCC", "Jettie Pickens", "MEM-RMO0120", "Safe", "-", "-", "18m 6s", "-", "95.8"],
    ["MCC", "Jermaine Underwood", "MEM-RMO0121", "Safe", "-", "-", "9s", "-", "86.3"],
    ["MCC", "Robert Cobelo", "MIA-OOF07001", "Safe", "-", "-", "7s", "-", "472.5"],
    ["MCC", "Bianca Smith", "SAV-CI1924", "Safe", "Hgiu 516448", "Safe", "50s", "37s", "267.2"],
    ["MCC", "Quanterrio Wright", "SAV-CI1926", "Safe", "-", "-", "24s", "-", "363.6"],
    ["MCC", "Sam Mcgowan", "ATL- CI2034", "⚠ NO DVIR", M, M, M, M, "423.5"],
    ["MCC", "Jamal Johnson", "MDW-849", "⚠ NO DVIR", M, M, M, M, "618.6"],
    ["MCC", "Dominique Webster", "MDW-CF1852", "⚠ NO DVIR", M, M, M, M, "386.4"],
    ["MCC", "Brett Anderson", "MEM-CI2030", "⚠ NO DVIR", M, M, M, M, "167.6"],
]

# --- Hoja `Driver info` real (sin Truck# todavia) --------------------------
# Encabezados: #, DRIVER NAME, PHONE, EMAIL, COMPANY
DRIVER_INFO = [["#", "DRIVER NAME", "PHONE", "EMAIL", "COMPANY"]] + [
    [str(i + 1), name, "", email, comp] for i, (name, email, comp) in enumerate([
        ("CHRISTOPHER DOTSON", "dotson_chris25@yahoo.com", "MCC"),
        ("DANIEL HICKS", "dhicks773@yahoo.com", "MCC"),
        ("DEVION MCREYNOLDS", "devion804@gmail.com", "MCC"),
        ("DOMINIQUE WEBSTER", "dominiquewebster5@gmail.com", "MCC"),
        ("EDWIN VITERI", "esviteri82@gmail.com", "MCC"),
        ("JOSEPH ZABINSKI", "jzabinski@gmail.com", "MCC"),
        ("KEVIN NEWSOME", "kevinnew1957@gmail.com", "MCC"),
        ("Reginald Robertson", "reginald.robertson23@gmail.com", "MCC"),
        ("Jamal Johnson", "jayjohnson5601@gmail.com", "MCC"),
        ("Kahari Brown", "Kahari.brown@yahoo.com", "MCC"),
        ("Jasmaine Harris", "jasmaine.harris0513@gmail.com", "MCC"),
        ("Rashod Lee", "rashodlee77@gmail.com", "MCC"),
        ("Ryan Davis", "r.davisincorporated@gmail.com", "MCC"),
        ("DAVID BARREN", "davidkbarrensr@gmail.com", "CHASER"),
        ("RASHON BENNETT", "rashonbennett4@gmail.com", "CHASER"),
        ("DURRELL BRISTER", "dtb7190@outlook.com", "CHASER"),
        ("KEITH CRAWFORD", "crawfordkeith34@gmail.com", "CHASER"),
        ("ONEIL DEASON", "ojdeason@gmail.com", "CHASER"),
        ("SHAWN DEMPSEY", "daddylongbombs@gmail.com", "CHASER"),
        ("CEDRIC DORSEY", "bae23na@gmail.com", "CHASER"),
        ("KHALID ENEFFAH", "morocco0170@gmail.com", "CHASER"),
        ("LAWRENCE GRUNDY", "grundy_lawrence@yahoo.com", "CHASER"),
        ("MICHAEL HEARD", "michealheard49@gmail.com", "CHASER"),
        ("ANTHONY HENRY", "kegtexas2444@gmail.com", "CHASER"),
        ("JULIO HERNANDEZ", "julio1992hernandez@gmail.com", "CHASER"),
        ("LARRY MCDANIEL", "m.carter100.mc@gmail.com", "CHASER"),
        ("EVERETT MCGLOTTEN", "eam3bo@yahoo.com", "CHASER"),
        ("STANFORD MOUTON", "stanfordmoutonjr@gmail.com", "CHASER"),
        ("SAMUEL SALAZAR", "principebejuco@gmail.com", "CHASER"),
        ("JOHN SAMUELS", "devinespark40@gmail.com", "CHASER"),
        ("VONDERRICK SMITH", "vonderricksmith2@gmail.com", "CHASER"),
        ("EARL STOCKTON", "earlstockton56@gmail.com", "CHASER"),
        ("ROSS WASHINGTON", "ross_washington@outlook.com", "CHASER"),
        ("CHRISTIAAN ZEEUW", "czeeuw1@gmail.com", "CHASER"),
        ("Robert Cobelo", "rcobelo0880@gmail.com", "MCC"),
        ("Quanterrio Wright", "q_dug@hotmail.com", "MCC"),
        ("Bianca Smith", "bianca.smith1993@yahoo.com", "MCC"),
        ("Michael Parham", "m.j.parham2@gmail.com", "MCC"),
        ("John Hawkins", "Johnhawkins49022@gmail.com", "MCC"),
        ("Marvin Clinton", "plookiesr65@gmail.com", "MCC"),
        ("Jimmone Jones", "Jimmonejones@gmail.com", "MCC"),
        ("Everick Morris", "Everickmorris@gmail.com", "MCC"),
        ("Melvin Tyms", "BlueskiesTPS@gmail.com", "MCC"),
        ("Deshario Gates", "dgreatest4@gmail.com", "MCC"),
        ("Victor Bingue", "onceamonthman@yahoo.com", "CHASER"),
        ("MICHEAL JOHNSON", "", "MCC"),
        ("Patrick Wells", "", "MCC"),
        ("Brett Anderson", "Brett.anderson215@yahoo.com", "MCC"),
        ("Jettie Pickens", "jettiepickens7@gmail.com", "MCC"),
        ("Joe Teague", "Teaguejoe@yahoo.com", "MCC"),
        ("Ahmad AlHindi", "alhindi2005@yahoo.com", "MCC"),
        ("Jarrod Snell", "jarrod.snell@gmail.com", "MCC"),
        ("Alonzo Starks", "mr.lostarks@yahoo.com", "MCC"),
        ("Clayton Mabon", "memphismabon@yahoo.com", "MCC"),
        ("Jermaine Underwood", "camaro79.ju@gmail.com", "MCC"),
        ("Robert Lotz", "roberttlotz@proton.me", "CHASER"),
    ])
]


def show(title, sheet_values):
    print("=" * 70)
    print(title)
    print("=" * 70)
    book = parse_contacts(DRIVER_INFO)
    blocks = parse_blocks(sheet_values)
    for label in blocks:
        notices, review = build_notices(blocks[label], book)
        print(f"\n--- Bloque {label}: {len(notices)} a enviar, "
              f"{len(review)} a revisar ---")
        for n in notices:
            subj, _ = render_email(n, label)
            print(f"  ENVIAR -> {n.driver} <{n.email}>  [{n.region}]")
            print(f"           CC: {', '.join(n.cc)}")
            print(f"           Unidades: {'; '.join(n.units)}")
        for r in review:
            print(f"  REVISAR -> {r.driver} [{r.region or '??'}] "
                  f"({r.review_reason})  Unidades: {'; '.join(r.units)}")


if __name__ == "__main__":
    show("CHASER 6", CHASER_6)
    show("MCC 6", MCC_6)
