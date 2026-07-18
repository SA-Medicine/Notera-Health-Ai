@echo off
REM ── Notera Testing Lab — full DB reset (backup, drop old schemas, create lab, backfill)
REM Run this once to switch the database to the new humanized schema.
cd /d "%~dp0.."
echo Resetting database to the Testing Lab schema...
echo (a backup is written to db\backups first)
node db\reset.mjs %*
echo.
pause
