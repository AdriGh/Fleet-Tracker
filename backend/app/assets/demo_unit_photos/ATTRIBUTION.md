# Demo unit photos — attribution

Fotos de muestra que la flota demo (`FLEET_DEMO=1` / tenant sin ELD) usa como
fallback cuando la unidad no tiene foto subida. Solo aparecen en modo demo;
una foto real subida por el tenant siempre gana (v2.16.1: cobertura completa,
las 16 unidades demo tienen foto).

Todas provienen de **Wikimedia Commons** (licencias CC BY / CC BY-SA /
dominio público). La columna "Título original" es el fragmento del nombre de
archivo en Commons — buscar ese título ahí recupera la página fuente con
autor y licencia exacta.

| Archivo | Unidad demo | Título original en Commons |
|---------|-------------|----------------------------|
| `pete579.jpg` | 412 | Peterbilt 579 Lone Pine 2018-04-07 |
| `cascadia.jpg` | 418 | Transco Freightliner Cascadia |
| `cascadia_ryder.jpg` | 421 | Ryder Freightliner Cascadia |
| `cascadia_wm.jpg` | 305 | Walmart Freightliner Cascadia truck |
| `intl_lt.jpg` | 308 | 2019 International LT 625 |
| `t680.jpg` | 311 | Kenworth T680 in Hesperia (white) |
| `cascadia_blue.jpg` | 207 | Blue truck sky background (Werner Cascadia) |
| `penske_lt.jpg` | 214 | Penske Truck Leasing rental (International LT) |
| `vnl.jpg` | 503 | Volvo VNL 670 |
| `cascadia_otr.jpg` | 517 | Otr-vehicle-transport (Cascadia, Utah) |
| `reefer.jpg` | 53108 | Carrier reefer and trailer |
| `reefer_prime.jpg` | 53112 | PRIME Inc - Peterbilt Refrigerated |
| `reefer_utility.jpg` | 7841 | WAHID refrigerated semi-trailer (Utility) |
| `reefer_rigid.jpg` | 7846 | Peterbilt with refrigerated (straight truck)* |
| `flatbed_tires.jpg` | 4402 | Tire Transport Truck (46038169192) |
| `dryvan_eggs.jpg` | 4410 | International LT - semi trailer (Hillandale) |
| `kenworth.jpg` | (sin uso desde v2.16.1; era 311) | Bakersfield CA Truck Kenworth (W900) |

\* Nota de honestidad: `reefer_rigid.jpg` es un camión rígido con unidad de
frío, no un trailer — es la coincidencia más débil del set; reemplazar cuando
aparezca una foto mejor de trailer reefer.

No usar en marketing ni en producción con clientes reales: son placeholders
de demo. Producción usa fotos del cliente (subidas) o stock licenciado.
