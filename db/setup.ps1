# Notera database — one-time setup.
# Creates the Docker Postgres, secrets, .env, schema, and backfills existing data.
# Safe to re-run (reuses the existing password so it won't break your data volume).
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)   # repo root

function New-Key([int]$n){
  $b = New-Object byte[] ($n*2)
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ((([Convert]::ToBase64String($b)) -replace '[^A-Za-z0-9]','')).Substring(0,$n)
}
function Set-EnvLine($lines,$k,$v){
  if ($lines -match "^$k=") { $lines -replace "^$k=.*","$k=$v" } else { $lines + "$k=$v" }
}

Write-Host "== Notera database setup ==" -ForegroundColor Cyan

# 0. docker must be running
docker version *> $null
if ($LASTEXITCODE -ne 0) { Write-Error "Docker is not running. Start Docker Desktop and re-run."; exit 1 }

# 1. folders
New-Item -ItemType Directory -Force -Path db\secrets, db\backups, db\init | Out-Null

# 2. DB password (reuse if it already exists)
$pwPath = "$PWD\db\secrets\pg_password.txt"
if (Test-Path $pwPath) { $pw = (Get-Content $pwPath -Raw).Trim(); Write-Host "Reusing existing DB password." }
else { $pw = New-Key 24; [IO.File]::WriteAllText($pwPath, $pw); Write-Host "Generated a new DB password." }
$dburl = "postgres://notera_admin:$pw@localhost:5432/notera"

# 3. .env (create from example, then set the DB values)
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
$envtxt = Get-Content .env
$envtxt = Set-EnvLine $envtxt 'STORE_BACKEND' 'postgres'
$envtxt = Set-EnvLine $envtxt 'DATABASE_URL' $dburl
if (($envtxt -match '^DEID_ENC_KEY=CHANGE') -or (-not ($envtxt -match '^DEID_ENC_KEY='))) {
  $envtxt = Set-EnvLine $envtxt 'DEID_ENC_KEY' (New-Key 32)
}
Set-Content .env $envtxt
$deid = (((Get-Content .env) | Where-Object { $_ -match '^DEID_ENC_KEY=' }) -replace '^DEID_ENC_KEY=','')

# 4. start Postgres and wait for healthy
docker compose -f db/docker-compose.postgres.yml up -d
Write-Host "Waiting for Postgres to be healthy" -NoNewline
$h = ""
for ($i = 0; $i -lt 60; $i++) {
  $h = (docker inspect --format '{{.State.Health.Status}}' notera-postgres 2>$null)
  if ($h -eq 'healthy') { break }
  Start-Sleep 2; Write-Host "." -NoNewline
}
Write-Host ""
if ($h -ne 'healthy') { Write-Error "Postgres never became healthy. Check: docker compose -f db/docker-compose.postgres.yml logs postgres"; exit 1 }

# 5. install + create the lab schema + backfill existing gold/runs
npm install
$env:DATABASE_URL = $dburl
$env:DEID_ENC_KEY = $deid
node db/reset.mjs

Write-Host ""
Write-Host "== Database is LIVE on localhost:5432 ==" -ForegroundColor Green
Write-Host "  DATABASE_URL = $dburl"
Write-Host "  Next: npm run dev:backend    (STORE_BACKEND=postgres is already in .env)"
