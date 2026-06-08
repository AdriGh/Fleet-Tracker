@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Fleet Tracker
echo ============================================

REM --- Backend: dependencias de Python ---
py -c "import fastapi, sqlalchemy, googleapiclient, httpx" 1>nul 2>nul
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
echo Aplicacion abierta. Para cerrar, cierra la ventana del servidor.
endlocal
