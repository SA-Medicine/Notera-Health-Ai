@echo off
REM Stop the Notera database (data is preserved in the docker volume)
cd /d "%~dp0.."
docker compose -f db/docker-compose.postgres.yml down
