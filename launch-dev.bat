@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Fleet Tracker  (LOCAL / desarrollo - SQLite)
echo ============================================
REM Este launcher corre un server LOCAL con base SQLite (backend\dvir.db),
REM AISLADO de la nube. Util para desarrollo u offline. Para la app del dia a
REM dia conectada a los datos del server, usa launch.bat (cliente de la nube).

REM --- Auto-actualizar a la ultima version de la rama actual ---
REM (sin esto el launcher recompila el CODIGO VIEJO del disco: la version no
REM  sube y "no se ven los cambios". Fast-forward only: si no hay internet o
REM  la rama divergio, sigue con lo que haya sin romper nada.)
where git >nul 2>nul
if not errorlevel 1 (
  echo Buscando actualizaciones...
  git pull --ff-only
)

REM --- Backend: dependencias de Python ---
py -c "import fastapi, sqlalchemy, googleapiclient, httpx, anthropic" 1>nul 2>nul
if errorlevel 1 (
  echo Instalando dependencias del backend...
  py -m pip install -r backend\requirements.txt
)

REM --- Frontend: compilar la interfaz SIEMPRE (refleja la ultima version
REM tras un git pull; el build es rapido tras la primera instalacion) ---
echo Compilando la interfaz...
pushd frontend
if not exist "node_modules" call npm install
call npm run build
popd

REM --- Liberar el puerto 8765 si quedó un server viejo corriendo ---
REM (sin esto, un uvicorn previo en memoria sigue sirviendo CODIGO VIEJO:
REM  el nuevo no puede tomar el puerto y muere callado, y al reabrir la app
REM  "no se ven los cambios" / el badge muestra una version vieja.)
echo Liberando el puerto 8765 (si habia un server viejo)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" 1>nul 2>nul

REM --- Arrancar el servidor en segundo plano ---
start "Fleet Tracker - servidor" /min cmd /c ^
  "cd /d "%~dp0backend" && py -m uvicorn app.main:app --host 127.0.0.1 --port 8765"

REM --- Esperar a que el servidor responda ---
echo Iniciando servidor...
:wait
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:8765/api/health >nul 2>nul
if errorlevel 1 goto wait

REM --- Abrir en ventana de aplicacion ---
set "URL=http://127.0.0.1:8765"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%URL%
) else (
  start "" msedge --app=%URL%
)

echo.
echo Aplicacion LOCAL abierta. Para cerrar, cierra la ventana del servidor.
endlocal
