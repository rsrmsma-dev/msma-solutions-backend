# Sets up the heyhr database for the API server. Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File server\setup-db.ps1
#
# It asks for the postgres password (typed here, never saved), then:
#   1. deletes and rebuilds the heyhr database from database\schema.sql
#   2. creates the heyhr_app login the server uses (rows only; it can't drop tables)
#   3. writes server\.env with that login (git ignores this file)
#   4. installs the server's packages and loads the starting setup (roles, sign-ins, org structure)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin = "C:\Program Files\PostgreSQL\17\bin"
$psql = Join-Path $bin "psql.exe"
if (-not (Test-Path $psql)) { $psql = (Get-Command psql -ErrorAction SilentlyContinue).Source }
if (-not $psql) { throw "psql not found. Install PostgreSQL 17 first." }

Write-Host ""
Write-Host "This DELETES the heyhr database and rebuilds it empty from database\schema.sql." -ForegroundColor Yellow
$answer = Read-Host "Type YES to continue"
if ($answer -ne "YES") { Write-Host "Stopped. Nothing was changed."; exit 1 }

$secure = Read-Host "postgres password" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$env:PGHOST = "localhost"
$env:PGUSER = "postgres"

function Run-Sql([string]$db, [string]$sql) {
  & $psql -d $db -v ON_ERROR_STOP=1 -q -c $sql
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $sql" }
}

Write-Host "Rebuilding heyhr..."
Run-Sql "postgres" "DROP DATABASE IF EXISTS heyhr WITH (FORCE)"
Run-Sql "postgres" "CREATE DATABASE heyhr"
& $psql -d heyhr -v ON_ERROR_STOP=1 -q -f (Join-Path $root "database\schema.sql")
if ($LASTEXITCODE -ne 0) { throw "schema.sql failed" }

Write-Host "Creating the heyhr_app login..."
$chars = [char[]]"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$appPassword = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
Run-Sql "postgres" "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heyhr_app') THEN CREATE ROLE heyhr_app LOGIN; END IF; END `$`$"
Run-Sql "postgres" "ALTER ROLE heyhr_app WITH LOGIN PASSWORD '$appPassword'"
Run-Sql "heyhr" "GRANT CONNECT ON DATABASE heyhr TO heyhr_app; GRANT USAGE ON SCHEMA public TO heyhr_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO heyhr_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO heyhr_app; REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM heyhr_app"

# The key that encrypts employees' government numbers (server/src/crypto.ts). Keep a copy somewhere
# safe and separate from the backups: without it those numbers can't be read back.
$keyBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
$dataKey = [Convert]::ToBase64String($keyBytes)

$envFile = Join-Path $PSScriptRoot ".env"
@(
  "# Written by setup-db.ps1. Keep this file private; git ignores it.",
  "DATABASE_URL=postgres://heyhr_app:$appPassword@localhost:5432/heyhr",
  "PORT=3001",
  "HEYHR_DATA_KEY=$dataKey"
) | Set-Content -Path $envFile -Encoding ascii
$dataKey = $null
Remove-Item Env:PGPASSWORD
$appPassword = $null

Write-Host "Installing server packages..."
Push-Location $PSScriptRoot
npm install --silent
Write-Host "Loading roles, built-in sign-ins and the org structure..."
npm run seed --silent
Pop-Location

Write-Host ""
Write-Host "Done. Start the app with two terminals:" -ForegroundColor Green
Write-Host "  npm run server     (API on port 3001)"
Write-Host "  npm run dev        (the website)"
