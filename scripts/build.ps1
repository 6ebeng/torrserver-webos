# Builds the TorrServer webOS .ipk package.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build.ps1
#
# Steps: install ares-cli (if missing) -> vendor the service's node_modules ->
# fetch+verify the bundled arm7 TorrServer binary (if missing) -> normalise
# shell scripts to LF -> ares-package (the ~25-30 MB IPK contains the binary).

param([switch]$SkipServiceInstall)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# The ONE architecture webOS TVs use is 32-bit ARM (arm7). We pin a known-good
# upstream TorrServer release here and verify its SHA256, so the exact binary
# that ships to users is fixed and integrity-checked - no runtime download.
$TorrServerTag    = 'MatriX.142.2'
$TorrServerSha256 = '82eb053166319e5be1f5321c97fdba0dfe323e72e1dfd45bd9614638d1bc2871'
$TorrServerUrl    = "https://github.com/YouROK/TorrServer/releases/download/$TorrServerTag/TorrServer-linux-arm7"
$BinDir  = Join-Path $root 'service\bin'
$BinPath = Join-Path $BinDir 'TorrServer'

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

    # 3. Bundle the pinned arm7 TorrServer binary. If it is not already staged,
    #    download it and verify the SHA256 so a corrupted or tampered download
    #    fails the build instead of shipping. The binary travels inside the IPK,
    #    so nothing is downloaded on the TV at runtime.
    if (-not (Test-Path $BinPath)) {
        Write-Host "Fetching TorrServer $TorrServerTag (arm7)..."
        New-Item -ItemType Directory -Force $BinDir | Out-Null
        Invoke-WebRequest -Uri $TorrServerUrl -OutFile $BinPath -UseBasicParsing
    }
    $actual = (Get-FileHash $BinPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $TorrServerSha256) {
        throw "TorrServer binary SHA256 mismatch.`n  expected: $TorrServerSha256`n  actual:   $actual`nDelete service\bin\TorrServer and re-run to re-download."
    }
    Write-Host "TorrServer $TorrServerTag bundled (sha256 verified)."

    # 4. Normalise shell scripts to LF so they run on the TV.
    foreach ($f in @('service\torrserver-run.sh', 'service\torrserver-autostart')) {
        $p = Join-Path $root $f
        if (Test-Path $p) {
            $text = [System.IO.File]::ReadAllText($p) -replace "`r`n", "`n"
            [System.IO.File]::WriteAllText($p, $text)
        }
    }

    # 5. Package.
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
