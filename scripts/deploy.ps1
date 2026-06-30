# Deploys the TorrServer webOS app to a rooted LG TV over SSH.
#
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Autostart
#
# Defaults target the TV described in the project README (root / alpine).
# Uses PuTTY's pscp/plink (-pw) when available, otherwise OpenSSH scp/ssh
# (which will prompt for the password).

param(
  [string]$TVHost = '10.5.50.13',
  [string]$User = 'root',
  [string]$Password = 'alpine',
  [int]   $SshPort = 22,
  [string]$KeyPath = "$env:USERPROFILE\.ssh\torrserver_tv",
  [switch]$NoBuild,
  [switch]$Autostart
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$AppId = 'com.torrserver.app'
$SvcId = 'com.torrserver.app.service'

if (-not $NoBuild) {
  & (Join-Path $PSScriptRoot 'build.ps1')
}

$ipk = Get-ChildItem (Join-Path $root 'dist\*.ipk') -ErrorAction SilentlyContinue |
Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $ipk) { throw 'No .ipk found in dist/. Run scripts/build.ps1 first.' }

Write-Host "Deploying $($ipk.Name) to $User@${TVHost}:$SshPort" -ForegroundColor Cyan

$plink = Get-Command plink -ErrorAction SilentlyContinue
$pscp = Get-Command pscp  -ErrorAction SilentlyContinue
$usePutty = $plink -and $pscp
$useKey = (Test-Path $KeyPath)

function Copy-ToTV($local, $remote) {
  if ($usePutty) {
    & pscp.exe -batch -pw $Password -P $SshPort $local "$User@${TVHost}:$remote"
  }
  elseif ($useKey) {
    & scp -i $KeyPath -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -P $SshPort $local "$User@${TVHost}:$remote"
  }
  else {
    & scp -o StrictHostKeyChecking=accept-new -P $SshPort $local "$User@${TVHost}:$remote"
  }
  if ($LASTEXITCODE -ne 0) { throw "Copy failed ($local -> $remote)" }
}

function Invoke-TV($cmd) {
  if ($usePutty) {
    & plink.exe -batch -pw $Password -P $SshPort "$User@$TVHost" $cmd
  }
  elseif ($useKey) {
    & ssh -i $KeyPath -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p $SshPort "$User@$TVHost" $cmd
  }
  else {
    & ssh -o StrictHostKeyChecking=accept-new -p $SshPort "$User@$TVHost" $cmd
  }
}

# 1. Copy the package to the TV.
Copy-ToTV $ipk.FullName '/tmp/torrserver.ipk'

# 2-4. Install + elevate (+ optional autostart) in ONE SSH session (one password
#       prompt). The remote script is sent base64-encoded to avoid quoting issues.
Write-Host 'Installing package and elevating service on TV...'

$remote = @'
APPID=com.torrserver.app
SVCID=com.torrserver.app.service
echo "=== ipk on TV ==="
ls -la /tmp/torrserver.ipk 2>/dev/null || echo "MISSING /tmp/torrserver.ipk (copy failed)"
echo "=== installing (streaming until complete) ==="
luna-send -i -w 180000 luna://com.webos.appInstallService/dev/install "{\"id\":\"$APPID\",\"ipkUrl\":\"/tmp/torrserver.ipk\",\"subscribe\":true}" >/tmp/torrserver-install.log 2>&1 &
LS=$!
i=0
APPDIR=""
while [ $i -lt 150 ]; do
  for b in /media/developer/apps/usr/palm/applications /media/cryptofs/apps/usr/palm/applications; do
    [ -d "$b/$APPID" ] && APPDIR="$b/$APPID"
  done
  [ -n "$APPDIR" ] && break
  sleep 1; i=$((i + 1))
done
sleep 2
kill $LS 2>/dev/null
if [ -n "$APPDIR" ]; then
  echo "INSTALL OK -> $APPDIR"
else
  echo "INSTALL FAILED - last install messages:"
  tail -n 15 /tmp/torrserver-install.log 2>/dev/null
fi
ELEV=""
for p in /media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service /media/cryptofs/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service; do
  [ -x "$p" ] && ELEV="$p" && break
done
[ -z "$ELEV" ] && ELEV=$(command -v elevate-service 2>/dev/null)
[ -z "$ELEV" ] && ELEV=$(find /media /var/lib -name elevate-service 2>/dev/null | head -n1)
if [ -n "$ELEV" ] && [ -x "$ELEV" ]; then
  "$ELEV" "$SVCID" && echo "elevated via $ELEV"
else
  echo "WARN: Homebrew elevate-service not found - service will run unprivileged (data dir falls back to /tmp)."
fi
'@

if ($Autostart) {
  $remote += @'

mkdir -p /var/lib/webosbrew/init.d
for d in /media/developer/apps/usr/palm/services/com.torrserver.app.service /media/cryptofs/apps/usr/palm/services/com.torrserver.app.service; do
  if [ -f "$d/torrserver-autostart" ]; then cp "$d/torrserver-autostart" /var/lib/webosbrew/init.d/torrserver; chmod +x /var/lib/webosbrew/init.d/torrserver; echo "autostart installed"; break; fi
done
'@
}

$remote += "`ntrue`n"
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($remote -replace "`r`n", "`n")))
Invoke-TV "echo $b64 | base64 -d | sh"

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'Open "TorrServer" on the TV and press Start (first launch downloads TorrServer).'
Write-Host "Then manage it from any device at: http://${TVHost}:8090"
