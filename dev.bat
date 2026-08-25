@echo off
rem ============================================================
rem  Rigsmith - desarrollo local (doble click y listo)
rem
rem  Levanta backend (FastAPI :8765 con demo ELD) y frontend
rem  (Vite :5173) en dos ventanas propias y abre el navegador.
rem  Para apagar todo: cerrar las dos ventanas "Rigsmith ...".
rem
rem  El frontend se sirve con --host: desde el telefono (misma
rem  Wi-Fi) entra por la IP que se imprime abajo — asi se prueba
rem  el Walkaround con la camara real. La primera vez Windows
rem  Firewall pregunta por Node: "Permitir acceso".
rem ============================================================
cd /d "%~dp0"

rem OJO findstr: sin /c: el espacio separa DOS patrones (OR) y el guard
rem daria match con cualquier linea LISTENING. /c: = patron literal unico.
netstat -ano | findstr /r /c:":8765 .*LISTENING" >nul
if %errorlevel%==0 (
  echo [i] Backend ya corriendo en :8765 — se reusa.
) else (
  start "Rigsmith backend :8765" cmd /k "cd /d %~dp0backend && set FLEET_DEMO=1&& python -m uvicorn app.main:app --host 127.0.0.1 --port 8765"
)

netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul
if %errorlevel%==0 (
  echo [i] Frontend ya corriendo en :5173 — se reusa.
) else (
  start "Rigsmith frontend :5173" cmd /k "cd /d %~dp0frontend && npx vite --host --port 5173"
)

echo Esperando a que arranquen...
ping -n 7 127.0.0.1 >nul
start http://localhost:5173

echo.
echo   PC:        http://localhost:5173
echo   Telefono (misma Wi-Fi, para el Walkaround):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for %%b in (%%a) do echo              http://%%b:5173
)
echo.
echo   Demo ELD activa (FLEET_DEMO=1): flota, DVIR, Cold Chain y
echo   Walkaround funcionan sin ELD real.
echo.
pause
