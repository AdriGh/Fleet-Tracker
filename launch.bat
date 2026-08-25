@echo off
setlocal
REM ============================================================
REM   Rigsmith - Launcher de escritorio (nube con fallback local)
REM ============================================================
REM 1) Prueba la NUBE (VPS). Si responde, abre la app cloud en ventana
REM    de aplicacion (Chrome --app), como siempre.
REM 2) Si la nube NO responde (VPS caido / sin internet), levanta la app
REM    LOCAL (launch-dev.bat: build + server con SQLite y demo ELD) y
REM    abre esa. Cuando el VPS vuelva, este MISMO acceso directo vuelve
REM    solo a la nube - no hay que deshacer nada.
REM
REM Para cambiar la direccion (p.ej. dominio propio), edita SOLO la URL.

set "URL=https://fleet-tracker-fleettracker-pov0zh-95b032-187-77-255-150.sslip.io"

echo Probando la nube...
set "CODE=000"
for /f %%c in ('curl -s -o nul -w "%%{http_code}" -m 6 "%URL%" 2^>nul') do set "CODE=%%c"

REM Solo 200 cuenta como "nube sana": el 404 de Traefik (proxy vivo pero
REM app caida) tambien debe caer al local.
if "%CODE%"=="200" goto cloud

echo La nube no responde (HTTP %CODE%). Abriendo la app LOCAL...
call "%~dp0launch-dev.bat"
goto :eof

:cloud
echo Abriendo Rigsmith (nube)...

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
