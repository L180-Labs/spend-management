$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
if (-not (Test-Path 'apps/api/.env') -or -not (Test-Path 'apps/web/.env.local')) {
    throw 'Local environment files are missing. See docs/local-development.md.'
}
# Set before loading Nest modules: cron decorators read this at import time.
$env:NODE_ENV = 'development'
$env:LOCAL_DEV_MODE = 'true'
$env:NEXT_PUBLIC_LOCAL_DEV_MODE = 'true'
$env:DISABLE_INPROCESS_SCHEDULER = 'true'
$env:NEXT_TELEMETRY_DISABLED = '1'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'local-db.ps1') start
if ($LASTEXITCODE -ne 0) { throw 'Could not start the local database.' }
& pnpm dev
exit $LASTEXITCODE
