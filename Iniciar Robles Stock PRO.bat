@echo off
title Robles Stock PRO - Robles Pinturerias
cd /d "%~dp0"

echo ============================================
echo   ROBLES PINTURIERIAS - Sistema de Stock
echo ============================================
echo.

rem Verifica que el backend este compilado
if not exist "backend\dist\index.js" (
  echo [!] El backend no esta compilado. Ejecutando compilacion...
  call npm run build
  if errorlevel 1 (
    echo [!] Error de compilacion. Revisa la instalacion (ver docs\INSTALACION.md)
    pause
    exit /b 1
  )
)

rem Verifica la base de datos (.env)
if not exist "backend\.env" (
  echo [!] Falta backend\.env - ejecuta: npm run db:setup
  pause
  exit /b 1
)

echo Iniciando servidor en modo produccion...
set NODE_ENV=production
set PORT=4000
start "" http://localhost:4000
node backend\dist\index.js

echo.
echo El servidor se detuvo. Cierra esta ventana o presiona una tecla.
pause
