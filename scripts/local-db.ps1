param([ValidateSet('start', 'stop', 'status')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$pgCtl = Join-Path $repo 'scratch/local/pgsql/bin/pg_ctl.exe'
$data = Join-Path $repo 'scratch/local/database'
$log = Join-Path $repo 'scratch/local/postgres.log'
if (-not (Test-Path $pgCtl) -or -not (Test-Path (Join-Path $data 'PG_VERSION'))) {
    throw 'Local PostgreSQL is not initialized. See docs/local-development.md.'
}

& $pgCtl -D $data status
$running = $LASTEXITCODE -eq 0
if ($Action -eq 'status') { exit $LASTEXITCODE }
if ($Action -eq 'start' -and -not $running) {
    $arguments = @('-D', ('"' + $data + '"'), '-l', ('"' + $log + '"'), '-o', '"-p 5433 -h 127.0.0.1"', '-w', 'start')
    $process = Start-Process -FilePath $pgCtl -ArgumentList $arguments -WindowStyle Hidden -PassThru
    # Wait only for pg_ctl; Start-Process -Wait also waits for its server child.
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "PostgreSQL failed to start. See $log" }
}
if ($Action -eq 'stop' -and $running) {
    & $pgCtl -D $data -m fast -w stop
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL failed to stop.' }
}
exit 0
