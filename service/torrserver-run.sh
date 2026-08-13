#!/bin/sh
#
# TorrServer control script for webOS (POSIX sh / busybox compatible).
#
# Subcommands: install | start | stop | restart | update | status | logs |
#              datadir | latest | versions | select-version | enable-autostart |
#              disable-autostart
#
# It auto-detects a writable + exec-capable data directory, installs the
# bundled TorrServer binary (a single static Go build shipped inside the IPK,
# so nothing is downloaded at runtime), and supervises the process via a pid
# file. Because the TorrServer binary is statically linked, no extra runtime
# libraries are needed - install, chmod, run.
#
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
PORT=8090
# The TorrServer binary is bundled with the app (see build.ps1) - there is no
# runtime download, so no GitHub API, no checksum-less fetch, and no fragile
# dependence on upstream release asset names.
BUNDLED_BIN="$SCRIPT_DIR/bin/TorrServer"
AUTOSTART_SRC="$SCRIPT_DIR/torrserver-autostart"
AUTOSTART_DST="/var/lib/webosbrew/init.d/torrserver"
# App icon shown on toast notifications. The service lives in .../services/<id>
# while the icon ships in the sibling .../applications/com.torrserver.app dir.
APP_ICON="${SCRIPT_DIR%/services/*}/applications/com.torrserver.app/icon.png"

# --------------------------------------------------------------------------
# Pick a data directory that is both writable and allows execution. Falls back
# through several candidates so it works on retail, dev and rooted firmwares.
# Override with the TORRSERVER_DATA environment variable.
# --------------------------------------------------------------------------
pick_datadir() {
    if [ -n "${TORRSERVER_DATA:-}" ]; then
        if mkdir -p "$TORRSERVER_DATA" 2>/dev/null; then echo "$TORRSERVER_DATA"; return 0; fi
    fi
    for d in /media/developer/torrserver /home/root/torrserver /media/internal/.torrserver /tmp/torrserver; do
        # Fast path: a dir validated on an earlier run keeps an .exec_ok marker.
        # Exec-capability is a static mount property, so while the marker (and the
        # dir) still exist and the dir is writable we skip the write/chmod/exec
        # probe entirely. Without this every status poll (every 2s) would create,
        # chmod and run a probe file - needless disk churn on the TV.
        if [ -f "$d/.exec_ok" ] && [ -w "$d" ]; then echo "$d"; return 0; fi
        mkdir -p "$d" 2>/dev/null || continue
        if ( echo x >"$d/.w" ) 2>/dev/null; then
            printf '#!/bin/sh\nexit 0\n' >"$d/.x" 2>/dev/null
            chmod +x "$d/.x" 2>/dev/null
            if "$d/.x" 2>/dev/null; then
                rm -f "$d/.w" "$d/.x" 2>/dev/null
                : >"$d/.exec_ok" 2>/dev/null
                echo "$d"; return 0
            fi
        fi
        rm -f "$d/.w" "$d/.x" 2>/dev/null
    done
    echo /tmp/torrserver
}

DATA_DIR=$(pick_datadir)
APP_DIR="$DATA_DIR/app"
DATA_SUB="$DATA_DIR/data"
LOG="$DATA_DIR/torrserver.log"
PIDFILE="$DATA_DIR/torrserver.pid"
STATEFILE="$DATA_DIR/state"
VERFILE="$DATA_DIR/version"
BIN="$APP_DIR/TorrServer"
SETTINGS_FILE="$DATA_SUB/settings.json"
CACHEFILE="$DATA_DIR/.cache_path"
WANTCACHEFILE="$DATA_DIR/.want_cache"
ACCS_FILE="$DATA_SUB/accs.db"
mkdir -p "$DATA_DIR" "$APP_DIR" "$DATA_SUB" "$DATA_DIR/tmp" 2>/dev/null

set_state() { echo "$1" >"$STATEFILE" 2>/dev/null; }

# The boot hook lives on the host filesystem under /var/lib/webosbrew and is run
# as root at startup. Writing or removing it requires root, which the app gets
# by asking the Homebrew Channel's exec service (the frontend manages the hook).
# Autostart is OFF by default and only enabled when the user explicitly toggles
# it on - nothing here enables it automatically.
autostart_enabled() { [ -f "$AUTOSTART_DST" ]; }

# Whether autostart can actually be toggled on this TV. Writing the boot hook
# requires root on a rooted/Homebrew TV, so a jailed service (uid != 0) or a TV
# without the webosbrew init.d directory cannot persist the hook, and the UI
# greys the Autostart button out in that case.
autostart_available() {
    [ "$(id -u 2>/dev/null)" = "0" ] || return 1
    _ad=$(dirname "$AUTOSTART_DST")
    [ -d "$_ad" ] || mkdir -p "$_ad" 2>/dev/null || return 1
    [ -w "$_ad" ]
}

enable_autostart() {
    mkdir -p "$(dirname "$AUTOSTART_DST")" 2>/dev/null
    if [ -f "$AUTOSTART_SRC" ]; then
        cp "$AUTOSTART_SRC" "$AUTOSTART_DST" 2>/dev/null && chmod +x "$AUTOSTART_DST" 2>/dev/null
    fi
    autostart_enabled
}

disable_autostart() {
    rm -f "$AUTOSTART_DST" 2>/dev/null
    ! autostart_enabled
}

# Launch a long-running subcommand in its OWN session so it survives webOS
# tearing down the (short-lived) JS service after the Luna call returns.
spawn_bg() {
    if command -v setsid >/dev/null 2>&1; then
        setsid sh "$0" "$1" </dev/null >>"$LOG" 2>&1 &
    else
        nohup sh "$0" "$1" </dev/null >>"$LOG" 2>&1 &
    fi
}

# webOS userspace is 32-bit ARM on every TV, and the TorrServer binary is
# bundled with the app, so there is exactly one architecture to care about:
ARCH="arm7"

# Is TorrServer alive?  We deliberately avoid "pgrep -f <binary path>": the path
# is part of pgrep's own argv, so when the UI polls status every 2s two pgrep
# runs match EACH OTHER's command line and report a false positive. That made
# do_start believe the server was already up and skip the first-run download
# (empty app dir, state stuck at "running"). Instead trust our pid file -
# verified against /proc/<pid>/cmdline so a recycled PID can't fool us - and fall
# back to an exact process-NAME match (comm), which never matches pgrep itself.
is_running() {
    if [ -f "$PIDFILE" ]; then
        _p=$(cat "$PIDFILE" 2>/dev/null)
        if [ -n "$_p" ] && [ -r "/proc/$_p/cmdline" ]; then
            case "$(tr '\0' ' ' < "/proc/$_p/cmdline" 2>/dev/null)" in
                *TorrServer*) return 0 ;;
            esac
        fi
    fi
    if command -v pgrep >/dev/null 2>&1; then
        _p=$(pgrep -x TorrServer 2>/dev/null | head -n1)
        if [ -n "$_p" ]; then echo "$_p" > "$PIDFILE"; return 0; fi
    fi
    return 1
}

# Install the bundled TorrServer binary into the data dir. The binary ships
# inside the IPK (see build.ps1), so this is a local copy - nothing is fetched
# from the network and the bytes are the exact ones verified at build time.
do_install() {
    [ "${TS_QUIET:-}" = 1 ] || set_state "installing"
    if [ ! -f "$BUNDLED_BIN" ]; then set_state "error:binmissing"; return 1; fi
    mkdir -p "$APP_DIR" 2>/dev/null
    if ! cp "$BUNDLED_BIN" "$BIN" 2>/dev/null; then set_state "error:install"; return 1; fi
    chmod +x "$BIN" 2>/dev/null
    if [ ! -x "$BIN" ]; then set_state "error:binmissing"; return 1; fi
    # Record the bundled TorrServer version so the UI can show it.
    echo "MatriX.142.2" >"$VERFILE" 2>/dev/null
    [ "${TS_QUIET:-}" = 1 ] || set_state "stopped"
    return 0
}

# Is TorrServer actually SERVING yet?  is_running only proves the process exists;
# the HTTP port takes another moment to bind. We treat the server as "running"
# only once the port answers, so the UI keeps showing "Starting…" until the Web
# UI is genuinely reachable instead of flashing the green Running chip a second
# after launch. curl without -f returns success for any HTTP reply (even a 404),
# so this just confirms the socket is accepting connections; connection-refused
# (port not bound yet) is a non-zero exit. Falls back to a raw /proc/net/tcp
# listen-port check when curl is unavailable.
server_responding() {
    if command -v curl >/dev/null 2>&1; then
        curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/echo" 2>/dev/null
        return $?
    fi
    _hex=$(printf '%04X' "$PORT" 2>/dev/null)
    [ -n "$_hex" ] && grep -qi ":$_hex 00000000:0000 0A" /proc/net/tcp 2>/dev/null
}

# --------------------------------------------------------------------------
# Torrent cache / download location.
#
# The TorrServer binary and its database always stay on internal storage (the
# binary must live on an exec-capable filesystem, which USB mounts on webOS are
# usually not). Only the torrent piece cache / downloads are moved to USB, via
# TorrServer's UseDisk + TorrentsSavePath settings. The chosen cache directory
# is remembered in CACHEFILE; empty/absent means the default small in-RAM cache.
# --------------------------------------------------------------------------
cache_path() { cat "$CACHEFILE" 2>/dev/null; }

# List USB storage usable for the disk cache: every writable mount point under
# /tmp/usb (or /media/usb) from /proc/mounts, one per line as "<path>|<free-KB>".
list_usb() {
    awk '{print $2}' /proc/mounts 2>/dev/null | while read -r mp; do
        case "$mp" in
            /tmp/usb/*|/media/usb/*)
                if ( echo x >"$mp/.tsw" ) 2>/dev/null; then
                    rm -f "$mp/.tsw" 2>/dev/null
                    kb=$(df -k "$mp" 2>/dev/null | awk 'NR==2{print $4}')
                    [ -n "$kb" ] || kb=0
                    echo "$mp|$kb"
                fi
                ;;
        esac
    done
}

# HTTP auth. TorrServer enables Basic Auth with the -a (--httpauth) flag and
# reads the credentials from accs.db (a JSON {"user":"pass"} map) in the config
# dir - NOT from settings.json. We generate one stable random password per
# install, store it in accs.db, and show it in the app so the user can log in
# from a phone/PC on the LAN.
http_user() { echo "torrserver"; }
http_pass() {
    if [ -f "$ACCS_FILE" ]; then
        # Extract the stored password from the accs.db JSON map.
        sed -n 's/.*"'"$(http_user)"'"[ ]*:[ ]*"\([^"]*\)".*/\1/p' "$ACCS_FILE" 2>/dev/null
        return
    fi
    echo ""
}

# Create accs.db with a fresh random password if it does not exist yet.
ensure_accs() {
    mkdir -p "$DATA_SUB" 2>/dev/null
    if [ -f "$ACCS_FILE" ]; then return 0; fi
    _p=$( (dd if=/dev/urandom bs=9 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n') )
    [ -n "$_p" ] || _p="$(date +%s)$$RANDOM"
    printf '{"%s":"%s"}\n' "$(http_user)" "$_p" >"$ACCS_FILE" 2>/dev/null
    chmod 600 "$ACCS_FILE" 2>/dev/null
}

# Merge our TV-safe defaults into TorrServer's settings.json WITHOUT discarding
# anything the user configured in the web UI. We only create the file when it
# does not exist yet, then patch just the keys we own (BitTorr network/cache),
# leaving every other key untouched. TorrServer only reads the file when
# StoreSettingsInJson is true, which we set on creation.
write_settings() {
    _cp=$(cache_path)
    # Only use the USB cache if its directory is still present and writable, so a
    # drive that has been unplugged cleanly falls back to the in-RAM cache
    # instead of silently writing to a phantom path on the /tmp tmpfs.
    if [ -n "$_cp" ] && [ -d "$_cp" ] && [ -w "$_cp" ]; then
        _usedisk=true; _save="$_cp"; _csize=536870912
    else
        _usedisk=false; _save=""; _csize=67108864
    fi
    mkdir -p "$DATA_SUB" 2>/dev/null

    if [ ! -f "$SETTINGS_FILE" ]; then
        # First run: create a complete config with the TV-safe network defaults
        # (DHT/uTP/PEX/UPnP/LPD off so they cannot exhaust the limited webOS
        # network stack) and the chosen cache location.
        cat >"$SETTINGS_FILE" <<EOF
{
  "BitTorr": {
    "CacheSize": $_csize,
    "ConnectionsLimit": 100,
    "DisableDHT": true,
    "DisableUPNP": true,
    "DisableUTP": true,
    "DisablePEX": true,
    "EnableLPD": false,
    "StoreSettingsInJson": true,
    "UseDisk": $_usedisk,
    "TorrentsSavePath": "$_save",
    "RemoveCacheOnDrop": true
  }
}
EOF
        chmod 600 "$SETTINGS_FILE" 2>/dev/null
        return 0
    fi

    # Later runs: patch ONLY the BitTorr keys we manage, preserving user edits.
    _tmp="$SETTINGS_FILE.tmp"
    awk -v usedisk="$_usedisk" -v save="$_save" -v csize="$_csize" '
        /"UseDisk"[ ]*:/          { sub(/"UseDisk"[ ]*:[ ]*[a-z]+/, "\"UseDisk\": " usedisk) }
        /"TorrentsSavePath"[ ]*:/ { sub(/"TorrentsSavePath"[ ]*:[ ]*"[^"]*"/, "\"TorrentsSavePath\": \"" save "\"") }
        /"CacheSize"[ ]*:/        { sub(/"CacheSize"[ ]*:[ ]*[0-9]+/, "\"CacheSize\": " csize) }
        { print }' "$SETTINGS_FILE" >"$_tmp" 2>/dev/null && mv "$_tmp" "$SETTINGS_FILE" 2>/dev/null
    chmod 600 "$SETTINGS_FILE" 2>/dev/null
    rm -f "$_tmp" 2>/dev/null
}

# Choose where the torrent cache/downloads live. Argument is a USB mount path, or
# "ram"/"internal"/empty to return to the default in-RAM cache. The cache lives
# in a dedicated sub-folder of the mount so we never write to its root.
set_cache() {
    _want="${1:-}"
    case "$_want" in
        ""|ram|internal|RAM)
            rm -f "$CACHEFILE" 2>/dev/null
            write_settings
            echo "ram"
            return 0
            ;;
    esac
    _dir="$_want/torrserver-cache"
    if ! mkdir -p "$_dir" 2>/dev/null; then echo "error:mkdir"; return 1; fi
    # Make ONLY our dedicated cache folder writable - never touch the rest of
    # the mounted drive (the old `chmod -R 777 /tmp/usb` world-wrote every file
    # on the user's USB stick, which is both rude and a security problem).
    chmod 777 "$_dir" 2>/dev/null
    if ! ( echo x >"$_dir/.tsw" ) 2>/dev/null; then echo "error:readonly"; return 1; fi
    rm -f "$_dir/.tsw" 2>/dev/null
    echo "$_dir" >"$CACHEFILE" 2>/dev/null
    write_settings
    echo "$_dir"
    return 0
}

do_start() {
    if is_running; then set_state "running"; return 0; fi
    # Install/reinstall the bundled binary if it is missing or is a different
    # version than the one shipped in this package (e.g. after an app update).
    _instver=$(cat "$VERFILE" 2>/dev/null)
    if [ ! -x "$BIN" ] || [ "$_instver" != "MatriX.142.2" ]; then do_install || return 1; fi

    [ "${TS_QUIET:-}" = 1 ] || set_state "starting"

    # Merge the TV-safe config (network defaults, cache location) without
    # discarding any settings the user made in the web UI.
    write_settings
    # Make sure the HTTP-auth credentials file exists (Basic Auth via -a).
    ensure_accs

    cd "$APP_DIR" 2>/dev/null || { set_state "error:chdir"; return 1; }
    # GODEBUG=madvdontneed=1 keeps the Go runtime from returning memory to the OS
    # too eagerly - the same tuning the original launcher used on webOS.
    # -a turns on HTTP Basic Auth (credentials in accs.db) so the web UI / API
    # is not open to the whole LAN.
    nohup env -i \
        GODEBUG=madvdontneed=1 \
        PATH=/usr/bin:/bin \
        HOME="$DATA_DIR" TMPDIR="$DATA_DIR/tmp" \
        "$BIN" -p "$PORT" -d "$DATA_SUB" -a >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"

    # Wait for the program to actually start SERVING (not merely exist): declare
    # "running" only once the HTTP port answers, so the UI keeps showing
    # "Starting…" until the Web UI is genuinely reachable, instead of flipping to
    # the green Running chip a second after launch (which is visible on a
    # stop→start, where there is no download to mask it).
    i=0
    while [ $i -lt 30 ]; do
        sleep 1
        if is_running && server_responding; then
            set_state "running"
            ver=$(cat "$VERFILE" 2>/dev/null)
            luna-send -n 1 -f luna://com.webos.notification/createToast \
                "{\"message\":\"TorrServer ${ver:-} is now running\",\"iconUrl\":\"$APP_ICON\"}" >/dev/null 2>&1
            return 0
        fi
        i=$((i + 1))
    done

    # The port never answered within the window. If the process is at least alive
    # (slow TV still binding), report running rather than a false error; only if
    # it is truly gone do we surface a launch failure.
    if is_running; then set_state "running"; return 0; fi
    set_state "error:launch"
    return 1
}

do_stop() {
    [ "${TS_QUIET:-}" = 1 ] || set_state "stopping"
    if [ -f "$PIDFILE" ]; then
        _p=$(cat "$PIDFILE" 2>/dev/null)
        if [ -n "$_p" ]; then
            kill "$_p" 2>/dev/null
            i=0
            while kill -0 "$_p" 2>/dev/null; do
                i=$((i + 1)); [ "$i" -ge 10 ] && break
                sleep 1
            done
            kill -9 "$_p" 2>/dev/null
        fi
        rm -f "$PIDFILE"
    fi
    if command -v pkill >/dev/null 2>&1; then pkill -f "$BIN" 2>/dev/null; fi
    # Wait until the binary is fully gone so the port (8090) is released before
    # any subsequent start, otherwise restart hits "address already in use".
    i=0
    while is_running; do
        pkill -9 -f "$BIN" 2>/dev/null
        i=$((i + 1)); [ "$i" -ge 10 ] && break
        sleep 1
    done
    # Brief grace period for the TCP socket to flush out of TIME_WAIT.
    sleep 1
    [ "${TS_QUIET:-}" = 1 ] || set_state "stopped"
    return 0
}

do_status() {
    if is_running; then r=true; else r=false; fi
    if [ -x "$BIN" ]; then ins=true; else ins=false; fi
    st=$(cat "$STATEFILE" 2>/dev/null); [ -z "$st" ] && st="idle"
    # If the process is gone, never report a stale "running" state (e.g. after
    # the server was killed out-of-band on a rooted TV). Transitional states
    # (starting/stopping/restarting/updating/installing/downloading) are driven
    # by an in-progress background operation that sets the terminal state
    # itself, so leave them alone here so the UI can show real progress.
    if [ "$r" = false ]; then
        case "$st" in running) st="stopped" ;; esac
    fi
    ver=$(cat "$VERFILE" 2>/dev/null)

    if autostart_enabled; then as=true; else as=false; fi
    if autostart_available; then aa=true; else aa=false; fi
    cp=$(cache_path)
    ensure_accs
    printf '{"running":%s,"installed":%s,"state":"%s","version":"%s","arch":"%s","port":%s,"dataDir":"%s","cachePath":"%s","autostart":%s,"autostartAvailable":%s,"httpUser":"%s","httpPass":"%s"}\n' \
        "$r" "$ins" "$st" "$ver" "$ARCH" "$PORT" "$DATA_DIR" "$cp" "$as" "$aa" "$(http_user)" "$(http_pass)"
}

case "${1:-}" in
    start)    spawn_bg _start ;;
    install)  spawn_bg _install ;;
    restart)  spawn_bg _restart ;;
    stop)     do_stop ;;
    status)   do_status ;;
    logs)     tail -n "${2:-200}" "$LOG" 2>/dev/null ;;
    datadir)  echo "$DATA_DIR" ;;
    cache)    cache_path ;;
    list-usb) list_usb ;;
    set-storage) echo "${2:-}" >"$WANTCACHEFILE" 2>/dev/null; spawn_bg _set_storage ;;
    enable-autostart)  enable_autostart && echo "enabled" || echo "failed" ;;
    disable-autostart) disable_autostart && echo "disabled" || echo "failed" ;;
    _start)   do_start ;;
    _install) do_install ;;
    _restart) TS_QUIET=1; set_state "restarting"; do_stop; do_start ;;
    _set_storage) TS_QUIET=1; set_cache "$(cat "$WANTCACHEFILE" 2>/dev/null)"; if is_running; then set_state "restarting"; do_stop; do_start; else set_state "stopped"; fi ;;
    *) echo "usage: $0 {install|start|stop|restart|status|logs|datadir|cache|list-usb|set-storage|enable-autostart|disable-autostart}"; exit 1 ;;
esac
