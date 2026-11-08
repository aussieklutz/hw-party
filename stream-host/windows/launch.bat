@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1
echo.
echo Stream host stopped.
pause
