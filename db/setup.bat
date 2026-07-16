@echo off
REM One-time database setup (runs db\setup.ps1)
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0setup.ps1"
echo.
pause
