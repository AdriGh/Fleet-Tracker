@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   Fleet Tracker - Limpiar para DEMO
echo ============================================================
echo.
echo Esto BORRA todos los datos y credenciales locales del
echo ex-empleador y deja la app limpia en modo DEMO:
echo.
echo   - backend\*.local.json   (tokens, contactos, config)
echo   - backend\*.local.csv     (exports)
echo   - roster.csv
echo   - backend\dvir.db         (reportes guardados con data real)
echo   - backend\uploads\        (documentos de unidades)
echo   - backend\.jobs\          (Excel temporales)
echo.
echo NO se puede deshacer.
echo.
set /p ok="Escribi SI (mayusculas) para continuar: "
if /i not "%ok%"=="SI" (
  echo.
  echo Cancelado. No se borro nada.
  pause
  exit /b
)

del /q "backend\*.local.json" 2>nul
del /q "backend\*.local.csv" 2>nul
del /q "roster.csv" 2>nul
del /q "backend\dvir.db" 2>nul
rmdir /s /q "backend\uploads" 2>nul
rmdir /s /q "backend\.jobs" 2>nul

echo.
echo Listo. Fleet Tracker quedo limpio (modo demo).
echo Abrilo con el launcher: vas a tener que crear un nuevo usuario admin.
echo.
pause
