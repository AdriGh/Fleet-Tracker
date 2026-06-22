@echo off
setlocal
REM ============================================================
REM   Fleet Tracker - App de escritorio (cliente de la NUBE)
REM ============================================================
REM Abre la app de PRODUCCION en una ventana de aplicacion (Chrome --app).
REM Usa la MISMA base de datos que el server (Postgres en el VPS): al loguear
REM ves los datos reales del cloud, no una copia local. No corre nada en tu PC.
REM
REM Para cambiar la direccion (p.ej. cuando pongas un dominio propio), edita
REM SOLO la linea URL de abajo.
REM Para correr en LOCAL con SQLite (desarrollo/offline), usa launch-dev.bat.

set "URL=https://fleet-tracker-fleettracker-pov0zh-95b032-187-77-255-150.sslip.io"

echo Abriendo Fleet Tracker (nube)...

REM Busca Chrome en las rutas tipicas (sistema 64/32-bit y por-usuario).
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --app=%URL%
) else (
  REM Fallback: Microsoft Edge en modo aplicacion.
  start "" msedge --app=%URL%
)
endlocal
