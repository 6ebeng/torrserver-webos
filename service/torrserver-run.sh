#!/bin/sh
#
# TorrServer control script for webOS (POSIX sh / busybox compatible).
#
# Subcommands: install | start | stop | restart | update | status | logs |
#              datadir | latest | versions | select-version | enable-autostart |
#              disable-autostart
#
# It auto-detects a writable + exec-capable data directory, downloads the
# matching self-contained TorrServer build (a single static Go binary) from
# GitHub on first run, and supervises the process via a pid file. Because the
# TorrServer release artifacts are statically linked, no extra runtime
# libraries are needed - download, chmod, run.
#
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
PORT=8090
REPO="YouROK/TorrServer"
API_URL="https://api.github.com/repos/$REPO/releases/latest"
RELEASES_URL="https://api.github.com/repos/$REPO/releases?per_page=100"
UA="torrserver-webos"
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
PART="$DATA_DIR/torrserver.part"
TOTALFILE="$DATA_DIR/total"
ARCHFILE="$DATA_DIR/arch"
LATESTFILE="$DATA_DIR/latest"
VERSIONSFILE="$DATA_DIR/versions"
WANTVERFILE="$DATA_DIR/.want_version"
AUTOSTART_INIT="$DATA_DIR/.autostart_init"
mkdir -p "$DATA_DIR" "$APP_DIR" "$DATA_SUB" "$DATA_DIR/tmp" 2>/dev/null

set_state() { echo "$1" >"$STATEFILE" 2>/dev/null; }

# The boot hook lives on the host filesystem under /var/lib/webosbrew and is run
# as root at startup. Reading/writing it therefore requires the service to run
# elevated (root, un-jailed). The Homebrew Channel grants this at install time
# because the app manifest sets "rootRequired": true, so a plain filesystem
# check/copy/remove is all that is needed here.
autostart_enabled() { [ -f "$AUTOSTART_DST" ]; }

# Whether autostart can actually be toggled on this TV. It only works when the
# service runs elevated (root, un-jailed) on a rooted/Homebrew TV, so that it
# can write the boot hook. A jailed service (uid != 0) or a TV without the
# webosbrew init.d directory cannot persist the hook, so the UI greys the
# Autostart button out in that case.
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

# Map the kernel/userspace architecture onto a TorrServer release asset suffix.
# LG webOS commonly reports a 64-bit aarch64 kernel while running a 32-bit ARM
# userspace, so we only pick arm64 when /bin/sh is itself a 64-bit ELF (5th byte
# of the ELF header: 01 = 32-bit, 02 = 64-bit). arm7 is the safe default.
detect_arch() {
    m=$(uname -m 2>/dev/null)
    case "$m" in
        x86_64|amd64)        echo "amd64"; return 0 ;;
        i?86|x86)            echo "386";   return 0 ;;
        armv7l|armv7|armhf)  echo "arm7";  return 0 ;;
        armv6l|armv5l|armv5|armel) echo "arm5"; return 0 ;;
        aarch64|arm64)
            cls=$(od -An -tx1 -N5 /bin/sh 2>/dev/null | tr -d ' \n' | cut -c9-10)
            if [ "$cls" = "02" ]; then echo "arm64"; else echo "arm7"; fi
            return 0 ;;
        armv*) echo "arm7"; return 0 ;;
    esac
    echo "arm7"
}

# download <url> <dest>  -> tries curl, then wget, then the Node fallback.
# Timeouts abort only on a stalled connection (not on a slow-but-progressing
# large download), so a flaky network can never wedge us on "downloading".
download() {
    _u="$1"; _d="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --connect-timeout 30 --speed-limit 1024 --speed-time 60 \
             --retry 3 --retry-delay 3 -A "$UA" -o "$_d" "$_u" && return 0
    fi
    if command -v wget >/dev/null 2>&1; then
        wget -q -T 60 -O "$_d" "$_u" && return 0
    fi
    if command -v node >/dev/null 2>&1; then
        node "$SCRIPT_DIR/download.js" "$_u" "$_d" && return 0
    fi
    return 1
}

# Fetch the latest release tag from GitHub and cache it. Returns the cached
# value immediately if checked within the last hour, so polling stays cheap.
do_latest() {
    if [ -f "$LATESTFILE" ]; then
        _age=$(( $(date +%s) - $(date -r "$LATESTFILE" +%s 2>/dev/null || echo 0) ))
        if [ "$_age" -lt 3600 ]; then cat "$LATESTFILE"; return 0; fi
    fi
    _j="$DATA_DIR/release-check.json"
    if download "$API_URL" "$_j"; then
        _v=$(grep -o '"tag_name"[ ]*:[ ]*"[^"]*"' "$_j" | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')
        rm -f "$_j" 2>/dev/null
        if [ -n "$_v" ]; then echo "$_v" >"$LATESTFILE"; echo "$_v"; return 0; fi
    fi
    cat "$LATESTFILE" 2>/dev/null
}

# List the available release tags from GitHub (newest first), one per line, so
# the UI can offer a manual version picker for downgrades / compatibility fixes.
# Cached for an hour to keep repeated opens of the picker cheap.
do_versions() {
    if [ -f "$VERSIONSFILE" ]; then
        _age=$(( $(date +%s) - $(date -r "$VERSIONSFILE" +%s 2>/dev/null || echo 0) ))
        if [ "$_age" -lt 3600 ]; then cat "$VERSIONSFILE"; return 0; fi
    fi
    _j="$DATA_DIR/releases.json"
    if download "$RELEASES_URL" "$_j"; then
        # Every release object carries exactly one "tag_name" and one
        # "prerelease" flag, in the same order, so extract both lists and pair
        # them line-for-line as "tag<TAB>true|false". This lets the UI label
        # pre-releases and pick the newest STABLE release as "latest".
        grep -oE '"tag_name"[ ]*:[ ]*"[^"]*"' "$_j" | sed 's/.*"\([^"]*\)"$/\1/' > "$_j.tags"
        grep -oE '"prerelease"[ ]*:[ ]*(true|false)' "$_j" | sed 's/.*:[ ]*//' > "$_j.pre"
        _tags=$(awk 'NR==FNR{p[FNR]=$0; next}{printf "%s\t%s\n", $0, (p[FNR]=="" ? "false" : p[FNR])}' "$_j.pre" "$_j.tags")
        rm -f "$_j" "$_j.tags" "$_j.pre" 2>/dev/null
        if [ -n "$_tags" ]; then
            printf '%s\n' "$_tags" >"$VERSIONSFILE"
            cat "$VERSIONSFILE"
            return 0
        fi
    fi
    cat "$VERSIONSFILE" 2>/dev/null
}

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

# do_install [version]  -> installs the latest release, or a specific release tag
# when a version is given (manual downgrade / compatibility pick).
do_install() {
    arch=$(detect_arch)
    asset="TorrServer-linux-$arch"
    _want="${1:-}"
    [ "${TS_QUIET:-}" = 1 ] || set_state "downloading"
    json="$DATA_DIR/release.json"
    rm -f "$PART" "$TOTALFILE" 2>/dev/null

    if [ -n "$_want" ]; then
        # Manual version pick: the release asset URL is predictable, so download
        # the requested tag straight from the releases download endpoint without
        # hitting (and being rate-limited by) the GitHub API.
        url="https://github.com/$REPO/releases/download/$_want/$asset"
        ver="$_want"
    else
        if ! download "$API_URL" "$json"; then set_state "error:api"; return 1; fi

        # The release JSON is minified. Each asset object lists "name" first and
        # the matching "browser_download_url" last, with "size" in between - so
        # anchor on the download URL and take the last "size" before it.
        url=$(grep -o '"browser_download_url":"[^"]*/'"$asset"'"' "$json" | head -n1 | sed 's/.*:"//; s/"$//')
        ver=$(grep -o '"tag_name"[ ]*:[ ]*"[^"]*"' "$json" | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')
        if [ -z "$url" ]; then set_state "error:asset"; return 1; fi

        prefix=$(grep -o '.*"browser_download_url":"[^"]*/'"$asset"'"' "$json" 2>/dev/null)
        total=$(printf '%s' "$prefix" | grep -o '"size"[ ]*:[ ]*[0-9][0-9]*' | tail -n1 | grep -o '[0-9][0-9]*' | tail -n1)
        [ -n "$total" ] && echo "$total" >"$TOTALFILE"
    fi

    # Download to a .part file so do_status can report live byte progress.
    if ! download "$url" "$PART"; then set_state "error:download"; return 1; fi

    # Guard against a captive-portal / 404 HTML page being saved as the binary:
    # a real TorrServer build starts with the ELF magic bytes (7f 45 4c 46).
    magic=$(od -An -tx1 -N4 "$PART" 2>/dev/null | tr -d ' \n')
    if [ "$magic" != "7f454c46" ]; then set_state "error:download"; rm -f "$PART"; return 1; fi

    mkdir -p "$APP_DIR" 2>/dev/null
    if ! mv "$PART" "$BIN" 2>/dev/null; then set_state "error:install"; return 1; fi
    chmod +x "$BIN" 2>/dev/null
    if [ ! -x "$BIN" ]; then set_state "error:binmissing"; return 1; fi

    [ -n "$ver" ] && echo "$ver" >"$VERFILE"
    echo "$arch" >"$ARCHFILE"
    rm -f "$json" 2>/dev/null
    [ "${TS_QUIET:-}" = 1 ] || set_state "stopped"
    return 0
}

do_start() {
    if is_running; then set_state "running"; return 0; fi
    # Reinstall if missing or if the previously installed arch no longer matches.
    want=$(detect_arch)
    have=$(cat "$ARCHFILE" 2>/dev/null)
    if [ ! -x "$BIN" ] || [ "$want" != "$have" ]; then do_install || return 1; fi

    [ "${TS_QUIET:-}" = 1 ] || set_state "starting"
    # Legacy parity: make any mounted USB storage writable for TorrServer caches.
    chmod -R 777 /tmp/usb 2>/dev/null

    # Seed a TV-safe default config if missing to prevent DHT/uTP from exhausting
    # the limited webOS network stack (nf_conntrack) which breaks streaming.
    SETTINGS_FILE="$DATA_SUB/settings.json"
    if [ ! -f "$SETTINGS_FILE" ]; then
        cat > "$SETTINGS_FILE" <<EOF
{
  "BitTorr": {
    "CacheSize": 67108864,
    "ConnectionsLimit": 100,
    "DisableDHT": true,
    "DisableUPNP": true,
    "DisableUTP": true,
    "DisablePEX": true,
    "EnableLPD": false,
    "StoreSettingsInJson": true
  }
}
EOF
    fi

    cd "$APP_DIR" 2>/dev/null || { set_state "error:chdir"; return 1; }
    # GODEBUG=madvdontneed=1 keeps the Go runtime from returning memory to the OS
    # too eagerly - the same tuning the original launcher used on webOS.
    nohup env -i \
        GODEBUG=madvdontneed=1 \
        PATH=/usr/bin:/bin \
        HOME="$DATA_DIR" TMPDIR="$DATA_DIR/tmp" \
        "$BIN" -p "$PORT" -d "$DATA_SUB" >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"

    # Wait for the program to bind (can take a few seconds on slow TVs).
    i=0
    while [ $i -lt 15 ]; do
        sleep 1
        if is_running; then
            set_state "running"
            # Autostart is ON by default: install the boot hook on the first
            # successful start. The one-time marker (also written when the user
            # explicitly toggles autostart) means a later "disable" is respected
            # and we never re-enable behind the user's back.
            if [ ! -f "$AUTOSTART_INIT" ]; then
                enable_autostart
                : >"$AUTOSTART_INIT" 2>/dev/null
            fi
            ver=$(cat "$VERFILE" 2>/dev/null)
            luna-send -n 1 -f luna://com.webos.notification/createToast \
                "{\"message\":\"TorrServer ${ver:-} is now running\",\"iconUrl\":\"$APP_ICON\"}" >/dev/null 2>&1
            return 0
        fi
        i=$((i + 1))
    done

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
    arch=$(detect_arch)

    dlb=0
    if [ -f "$PART" ]; then dlb=$(wc -c <"$PART" 2>/dev/null | tr -d ' '); fi
    [ -z "$dlb" ] && dlb=0
    tot=0
    if [ -f "$TOTALFILE" ]; then tot=$(cat "$TOTALFILE" 2>/dev/null | tr -d ' '); fi
    [ -z "$tot" ] && tot=0

    if autostart_enabled; then as=true; else as=false; fi
    if autostart_available; then aa=true; else aa=false; fi
    printf '{"running":%s,"installed":%s,"state":"%s","version":"%s","arch":"%s","port":%s,"downloadedBytes":%s,"totalBytes":%s,"dataDir":"%s","autostart":%s,"autostartAvailable":%s}\n' \
        "$r" "$ins" "$st" "$ver" "$arch" "$PORT" "$dlb" "$tot" "$DATA_DIR" "$as" "$aa"
}

case "${1:-}" in
    start)    spawn_bg _start ;;
    install)  spawn_bg _install ;;
    update)   spawn_bg _update ;;
    restart)  spawn_bg _restart ;;
    stop)     do_stop ;;
    status)   do_status ;;
    logs)     tail -n "${2:-200}" "$LOG" 2>/dev/null ;;
    datadir)  echo "$DATA_DIR" ;;
    latest)   do_latest ;;
    versions) do_versions ;;
    select-version) echo "${2:-}" >"$WANTVERFILE" 2>/dev/null; spawn_bg _install_version ;;
    enable-autostart)  enable_autostart && echo "enabled" || echo "failed"; : >"$AUTOSTART_INIT" 2>/dev/null ;;
    disable-autostart) disable_autostart && echo "disabled" || echo "failed"; : >"$AUTOSTART_INIT" 2>/dev/null ;;
    _start)   do_start ;;
    _install) do_install ;;
    _restart) TS_QUIET=1; set_state "restarting"; do_stop; do_start ;;
    _update)  TS_QUIET=1; set_state "updating"; do_stop; do_install && do_start ;;
    _install_version) TS_QUIET=1; set_state "installing"; do_stop; do_install "$(cat "$WANTVERFILE" 2>/dev/null)" && do_start ;;
    *) echo "usage: $0 {install|start|stop|restart|update|status|logs|datadir|latest|versions|select-version|enable-autostart|disable-autostart}"; exit 1 ;;
esac
