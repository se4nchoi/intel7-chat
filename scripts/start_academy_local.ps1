[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(ParameterSetName = 'Check')][switch]$Check,
    [Parameter(ParameterSetName = 'Admin')][switch]$CreateAdmin,
    [Parameter(ParameterSetName = 'Test')][switch]$Test,
    [Parameter(ParameterSetName = 'Stop')][switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$data = Join-Path $root 'data_dev'
$configPath = Join-Path $data 'academy-local.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    throw 'Missing private data_dev/academy-local.json. See docs/academy-windows-local.md.'
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pgCtl = Join-Path $config.pg_bin 'pg_ctl.exe'
if ($Stop) {
    & $pgCtl -D $config.pg_data -m fast -w stop
    exit $LASTEXITCODE
}

$env:MADI_DATABASE_URL = $config.database_url
$env:MADI_ALLOWED_HOSTS = 'localhost,127.0.0.1'
$env:MADI_HOST = '127.0.0.1'
$env:MADI_PORT = '8443'
$env:MADI_FILE_DIR = Join-Path $data 'academy-files'
$env:MADI_LOG_FILE = Join-Path $data 'academy.log'
$env:MADI_PG_BIN = $config.pg_bin
# This local profile deliberately runs without media services.
foreach ($key in @('MADI_SFU_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'MADI_CLASSROOMS_FILE')) {
    Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
}
& $pgCtl -D $config.pg_data status *> $null
if ($LASTEXITCODE -ne 0) {
    # Redirect handles to files so the background server cannot retain shell pipes.
    $pgStart = Start-Process -FilePath $pgCtl -WindowStyle Hidden -PassThru `
        -ArgumentList @('-D', ('"{0}"' -f $config.pg_data), '-l', ('"{0}"' -f (Join-Path $data 'academy-postgres.log')), '-w', 'start') `
        -RedirectStandardOutput (Join-Path $data 'pg-start.stdout.log') `
        -RedirectStandardError (Join-Path $data 'pg-start.stderr.log')
    $pgStart.WaitForExit()
    & $pgCtl -D $config.pg_data status *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL failed to start; inspect data_dev/pg-start.stderr.log.' }
}
if ($Check) {
    & uv run --locked python madi_run.py --check
} elseif ($CreateAdmin) {
    & uv run --locked python madi_run.py --create-admin
} elseif ($Test) {
    # Integration tests may drop tables; only the separate disposable database is used.
    if (-not $config.test_database_url -or $config.test_database_url -eq $config.database_url) {
        throw 'A separate disposable test_database_url is required.'
    }
    $env:MADI_TEST_DATABASE_URL = $config.test_database_url
    $env:MADI_DATABASE_URL = $config.test_database_url
    & uv run --locked python -m pytest -q
} else {
    foreach ($file in @('certs/server.crt', 'certs/server-key.pem')) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Missing local TLS file: $file" }
    }
    & uv run --locked python madi_run.py --check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Academy development app: https://localhost:8443/hub (Ctrl+C to stop)'
    & uv run --locked python -m uvicorn app.hub.application:create_app --factory --host 127.0.0.1 --port 8443 --workers 1 --ssl-certfile certs/server.crt --ssl-keyfile certs/server-key.pem --ws-max-size 65536 --ws-max-queue 16 --ws-per-message-deflate false
}
exit $LASTEXITCODE
