# Start only the isolated local prototype components after a reboot.
# Run from a normal PowerShell session under the Windows user who uses Chrome.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$data = Join-Path $root 'data_dev'
$bin = Join-Path $data 'pg-portable\pgsql\bin'
$required = @(
    (Join-Path $bin 'pg_ctl.exe'),
    (Join-Path $data 'pgdata\PG_VERSION'),
    (Join-Path $data 'pg-app.env'),
    (Join-Path $data 'livekit\livekit-server.exe'),
    (Join-Path $data 'livekit.yaml'),
    (Join-Path $data 'livekit.env'),
    (Join-Path $data 'caddy\caddy.exe'),
    (Join-Path $data 'Caddyfile'),
    (Join-Path $data 'tls\localhost.crt'),
    (Join-Path $root 'frontend\dist\index.html'),
    (Join-Path $root '.venv\Scripts\python.exe')
)
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Missing prototype file: $file" }
}

function Test-LocalListener([int]$port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $port -ErrorAction SilentlyContinue)
}

& (Join-Path $bin 'pg_ctl.exe') -D (Join-Path $data 'pgdata') status *> $null
if ($LASTEXITCODE -ne 0) {
    & (Join-Path $bin 'pg_ctl.exe') -D (Join-Path $data 'pgdata') -l (Join-Path $data 'postgres.log') -o '-h 127.0.0.1 -p 55432' -w start
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not start' }
}

if (-not (Test-LocalListener 7880)) {
    Start-Process -FilePath (Join-Path $data 'livekit\livekit-server.exe') `
        -ArgumentList @('--config', (Join-Path $data 'livekit.yaml')) `
        -WorkingDirectory $data -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $data 'livekit.stdout.log') `
        -RedirectStandardError (Join-Path $data 'livekit.stderr.log') | Out-Null
}

if (-not (Test-LocalListener 7882)) {
    Start-Process -FilePath (Join-Path $data 'caddy\caddy.exe') `
        -ArgumentList @('run', '--config', (Join-Path $data 'Caddyfile'), '--adapter', 'caddyfile') `
        -WorkingDirectory $data -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $data 'caddy.stdout.log') `
        -RedirectStandardError (Join-Path $data 'caddy.stderr.log') | Out-Null
}

if (-not (Test-LocalListener 8443)) {
    Start-Process -FilePath (Join-Path $root '.venv\Scripts\python.exe') `
        -ArgumentList @('prototype_run.py') `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $data 'server.stdout.log') `
        -RedirectStandardError (Join-Path $data 'server.stderr.log') | Out-Null
}

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ((Test-LocalListener 55432) -and (Test-LocalListener 7880) -and
        (Test-LocalListener 7882) -and (Test-LocalListener 8443)) { break }
    Start-Sleep -Milliseconds 500
}
if (-not ((Test-LocalListener 55432) -and (Test-LocalListener 7880) -and
    (Test-LocalListener 7882) -and (Test-LocalListener 8443))) {
    throw 'A prototype component did not open its local port; inspect data_dev/*.stderr.log'
}
$health = Invoke-RestMethod 'https://127.0.0.1:8443/hub/api/health'
if (-not $health.postgresql -or -not $health.sfu_configured) {
    throw 'Prototype hub health check failed'
}
Write-Output 'Prototype stack ready: https://127.0.0.1:8443/hub'
