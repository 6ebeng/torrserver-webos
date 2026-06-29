# Builds the TorrServer webOS .ipk package.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build.ps1
#
# Steps: install ares-cli (if missing) -> vendor the service's node_modules ->
# normalise shell scripts to LF -> ares-package.

param([switch]$SkipServiceInstall)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    # 1. Tooling: ares-cli (provides ares-package).
    $ares = Join-Path $root 'node_modules\.bin\ares-package.cmd'
    if (-not (Test-Path $ares)) {
        Write-Host 'Installing @webosose/ares-cli (one time)...'
        npm install --no-audit --no-fund
    }

    # 2. Vendor the service runtime dependency (webos-service).
    if (-not $SkipServiceInstall) {
        Write-Host 'Installing service dependencies...'
        Push-Location (Join-Path $root 'service')
        try { npm install --omit=dev --no-audit --no-fund } finally { Pop-Location }
    }

    # 3. Normalise shell scripts to LF so they run on the TV.
    foreach ($f in @('service\torrserver-run.sh', 'service\torrserver-autostart')) {
        $p = Join-Path $root $f
        if (Test-Path $p) {
            $text = [System.IO.File]::ReadAllText($p) -replace "`r`n", "`n"
            [System.IO.File]::WriteAllText($p, $text)
        }
    }

    # 4. Package.
    $dist = Join-Path $root 'dist'
    if (-not (Test-Path $dist)) { New-Item -ItemType Directory $dist | Out-Null }
    & $ares appinfo service -o dist

    $ipk = Get-ChildItem (Join-Path $dist '*.ipk') | Sort-Object LastWriteTime | Select-Object -Last 1
    Write-Host ''
    Write-Host "Built: $($ipk.FullName)" -ForegroundColor Green
}
finally {
    Pop-Location
}
