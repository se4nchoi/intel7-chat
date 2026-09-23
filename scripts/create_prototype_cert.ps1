param()

$ErrorActionPreference = 'Stop'
$prototypeRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tlsDir = Join-Path $prototypeRoot 'data_dev\tls'
$certPath = Join-Path $tlsDir 'localhost.crt'
$keyPath = Join-Path $tlsDir 'localhost.key'

if ((Test-Path -LiteralPath $certPath) -or (Test-Path -LiteralPath $keyPath)) {
    throw 'Prototype TLS certificate/key already exists; refusing to overwrite it.'
}

$openssl = (Get-Command openssl -ErrorAction Stop).Source
$opensslConfig = $env:OPENSSL_CONF
if (-not $opensslConfig) {
    $opensslConfig = Join-Path (Split-Path (Split-Path $openssl -Parent) -Parent) 'ssl\openssl.cnf'
}
if (-not (Test-Path -LiteralPath $opensslConfig)) {
    throw "OpenSSL configuration not found: $opensslConfig. Set OPENSSL_CONF to a valid openssl.cnf."
}
New-Item -ItemType Directory -Path $tlsDir -Force | Out-Null
$certOutput = & $openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 30 `
    -keyout $keyPath -out $certPath -subj '/CN=localhost' `
    -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' `
    -addext 'extendedKeyUsage=serverAuth' `
    -addext 'basicConstraints=critical,CA:FALSE' -config $opensslConfig 2>&1
if ($LASTEXITCODE -ne 0) { throw "OpenSSL certificate creation failed: $certOutput" }

Write-Output "Created local prototype certificate: $certPath"
Write-Output 'The certificate is not installed in the Windows trust store.'
Write-Output 'It can be used for a TLS smoke test; browser trust requires a separate step.'
