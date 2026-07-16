@echo off
REM Start the Notera database (run this before working on the project)
cd /d "%~dp0.."
docker compose -f db/docker-compose.postgres.yml up -d
docker compose -f db/docker-compose.postgres.yml ps
echo.
echo Postgres is starting on localhost:5432 - wait until STATUS shows "healthy".
