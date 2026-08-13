(function () {
	'use strict';

	var SERVICE = 'com.torrserver.app.service';
	var POLL_MS = 2000;
	var LOG_LINES = 300;

	function $(id) {
		return document.getElementById(id);
	}

	var pollTimer = null;
	var firstUrl = null;
	var logsVisible = false;
	var autostartOn = true;
	var autostartAvailable = true;
	var autostartBusy = false;
	var notRooted = false;
	var hbRooted = null; // null = not probed yet, true/false once known
	var hookOn = false; // boot hook present (managed by us via hbchannel exec)
	var hookKnown = false; // hookOn has been read at least once
	var pickerOpen = false;
	var pickerReturnId = 'btnStorage'; // button to refocus when the picker closes
	var pickerMode = 'storage';
	var storageCurrent = ''; // current torrent-cache path ('' = internal RAM)
	var lastStatus = {}; // most recent status, so button state can be recomputed any time
	var lampaAppId = null; // resolved Lampa app id (varies by build: lampa.tv, com.lampa.tv…)
	var lampaChecked = false; // frontend launch-point scan has completed
	// Action feedback: which button was pressed and a short lock window during
	// which the action buttons stay in a "loading" state, giving instant press
	// feedback before the first status poll arrives. Once the lock expires the
	// buttons follow the real server state, so nothing can get stuck greyed.
	var pendingBtnId = null;
	var clickLockUntil = 0;
	// Expected server-running outcome of the pending action (true after Start/
	// Restart/Update/Select, false after Stop, null = don't care) so the loading
	// pulse can end the instant that outcome actually shows.
	var pendingWant = null;

	// Homebrew Channel service — its methods are all in the public Luna group, so a
	// normal web app may call them. We use `exec` (runs as root) to manage the
	// autostart boot hook directly. This works on any rooted TV whether or not our
	// own service is elevated, and needs no reboot — unlike elevating the service.
	var HBCHANNEL = 'org.webosbrew.hbchannel.service';
	// The system application manager. Launching another app must be done from the
	// app itself — the frontend call carries our registered app identity, which
	// the manager accepts, whereas a call from the jailed background service (or
	// bare luna-send) is rejected as "invalid parameters" on webOS 9.
	var APPMGR = 'com.webos.applicationManager';
	var LAMPA_FALLBACK_ID = 'com.lampa.tv';
	// The system web browser. Launching it with a "target" URL opens the page in
	// the real browser instead of navigating our own app webview away.
	var BROWSER_ID = 'com.webos.app.browser';
	var HOOK = '/var/lib/webosbrew/init.d/torrserver';
	var SVC_DIRS = '/media/developer/apps/usr/palm/services/com.torrserver.app.service /media/cryptofs/apps/usr/palm/services/com.torrserver.app.service';
	var ENABLE_CMD =
		'for d in ' +
		SVC_DIRS +
		'; do [ -f "$d/torrserver-autostart" ] && SRC="$d/torrserver-autostart"; done; mkdir -p /var/lib/webosbrew/init.d && cp "$SRC" ' +
		HOOK +
		' && chmod 755 ' +
		HOOK +
		' && echo ENABLED || echo FAIL';
	var DISABLE_CMD = 'rm -f ' + HOOK + ' && echo DISABLED';
	var CHECK_CMD = '[ -f ' + HOOK + ' ] && echo ON || echo OFF';

	function msg(text) {
		$('msg').innerHTML = text || '';
	}

	function escapeHtml(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function svc(method, params, ok, fail, overrideService) {
		if (typeof window.lunaCall !== 'function' || typeof window.PalmServiceBridge === 'undefined') {
			msg('Not running on a webOS TV &mdash; service calls are unavailable in this preview.');
			if (fail) fail({});
			return;
		}
		window.lunaCall(overrideService || SERVICE, method, params || {}, {
			onSuccess: ok || function () {},
			onFailure:
				fail ||
				function (e) {
					msg('Error: ' + ((e && (e.errorText || e.errorMessage)) || 'service call failed'));
				},
		});
	}

	// Toggle a button's greyed-out state via a CSS class (not the disabled
	// attribute) so it keeps keyboard focus and D-pad navigation still works,
	// while its onclick guard ignores activation.
	function setBtnDisabled(btn, disabled) {
		if (!btn) return;
		if (disabled) {
			if (btn.className.indexOf('disabled') === -1) btn.className += ' disabled';
		} else {
			btn.className = btn.className.replace(/\s*disabled/g, '');
		}
	}
	function addClass(btn, c) {
		if (btn && btn.className.indexOf(c) === -1) btn.className += ' ' + c;
	}
	function removeClass(btn, c) {
		if (btn) btn.className = btn.className.replace(new RegExp('\\s*' + c, 'g'), '');
	}
	function isDisabled(btn) {
		return !!btn && btn.className.indexOf('disabled') !== -1;
	}

	// Transitional server states where an action is already under way and the
	// action buttons must stay locked/greyed until it resolves.
	function isBusyState(st) {
		st = st || '';
		return st === 'starting' || st === 'stopping' || st === 'restarting' || st === 'downloading' || st === 'updating' || st === 'installing';
	}

	// Drive the enabled/disabled + loading state of every action button from the
	// latest status, so e.g. Start greys out while running and Update greys out
	// when there is nothing to update. The pressed button pulses while its action
	// is in flight.
	function updateButtons(s) {
		s = s || lastStatus || {};
		var running = !!s.running;
		// "locked" is a brief window right after a press so the pressed button shows
		// loading instantly. Once it expires the buttons follow the real server
		// state, so nothing stays greyed if an action changed nothing.
		var locked = Date.now() < clickLockUntil;
		// End the bridge the instant the action's outcome actually shows (server
		// running/stopped as expected, or an error) so the loading pulse stops
		// immediately instead of running the full lock window.
		if (locked) {
			var settled = (s.state || '').indexOf('error') === 0;
			if (!settled && pendingWant !== null && !isBusyState(s.state) && running === pendingWant) settled = true;
			if (settled) locked = false;
		}
		if (!locked) clickLockUntil = 0;
		var busy = isBusyState(s.state) || locked;
		if (!busy) {
			pendingBtnId = null;
			pendingWant = null;
		}

		// Start/Stop are one toggle button: it shows the current state and does the
		// opposite action. It is enabled whenever no transition is in progress, and
		// uses the green "primary" style only when it would Start.
		var toggle = $('btnToggle');
		setBtnDisabled(toggle, busy);
		toggle.textContent = running ? 'Stop' : 'Start';
		if (running) removeClass(toggle, 'primary');
		else addClass(toggle, 'primary');
		setBtnDisabled($('btnRestart'), !running || busy);
		setBtnDisabled($('btnStorage'), busy);
		setBtnDisabled($('btnOpen'), !running || !firstUrl);
		setBtnDisabled($('btnAutostart'), !autostartAvailable || autostartBusy || busy);

		// Pulse the pressed button (and the autostart toggle while it works).
		var ids = ['btnToggle', 'btnRestart', 'btnAutostart', 'btnStorage'];
		for (var i = 0; i < ids.length; i++) removeClass($(ids[i]), 'loading');
		if (busy && pendingBtnId) addClass($(pendingBtnId), 'loading');
		if (autostartBusy) addClass($('btnAutostart'), 'loading');
	}

	// Record the pressed button and open a short feedback window so the press
	// shows a loading pulse instantly, before the first status poll arrives.
	function beginAction(btnId, message, wantRunning) {
		pendingBtnId = btnId;
		pendingWant = typeof wantRunning === 'boolean' ? wantRunning : null;
		clickLockUntil = Date.now() + 10000;
		if (message) msg(message);
		updateButtons(lastStatus);
	}

	function render(s) {
		s = s || {};
		lastStatus = s;

		var st0 = s.state || (s.running ? 'running' : 'stopped');
		var stateText;
		if (st0 === 'starting') {
			stateText = 'Starting…';
		} else if (st0 === 'stopping') {
			stateText = 'Stopping…';
		} else if (st0 === 'restarting') {
			stateText = 'Restarting…';
		} else if (st0 === 'running') {
			stateText = 'Running';
		} else if (st0 === 'stopped') {
			stateText = 'Stopped';
		} else {
			stateText = st0;
		}
		$('state').textContent = stateText;
		// Colour the Status value as a chip for the two stable states only; every
		// transitional/error state stays as plain text.
		if (st0 === 'running') {
			$('state').className = 'v statuschip running';
		} else if (st0 === 'stopped') {
			$('state').className = 'v statuschip stopped';
		} else {
			$('state').className = 'v';
		}
		$('version').textContent = s.version || '—';
		$('arch').textContent = s.arch || '—';
		// Show the web-UI login so the user can reach the (now authenticated) UI
		// from a phone or PC on the LAN.
		if (s.httpUser) {
			$('authrow').className = 'row';
			$('auth').textContent = s.httpUser + ' / ' + (s.httpPass || '');
		}
		$('datadir').textContent = s.dataDir || '—';
		// Torrent cache location: empty means the internal in-RAM cache.
		storageCurrent = s.cachePath || '';
		$('storage').textContent = storageCurrent ? 'USB: ' + storageCurrent : 'Internal (RAM cache)';
		// Autostart status. On a rooted TV we manage the boot hook ourselves via
		// the Homebrew Channel (root exec), which works whether or not our service
		// is elevated. Fall back to the service's own view until root is probed.
		var btnA = $('btnAutostart');
		if (hbRooted === true) {
			autostartAvailable = true;
			autostartOn = hookKnown ? hookOn : !!s.autostart;
		} else if (hbRooted === false || notRooted) {
			autostartAvailable = s.autostartAvailable !== false;
			autostartOn = !!s.autostart;
		} else {
			autostartAvailable = s.autostartAvailable !== false;
			autostartOn = !!s.autostart;
		}
		// The button itself is the Enabled/Disabled toggle (green when Enabled), so
		// no separate status text is shown on a rooted TV. A non-rooted TV has no
		// boot hook, so hide the toggle and explain why instead.
		if (!autostartAvailable) {
			$('autostart').textContent = 'Unavailable (TV not rooted)';
			addClass(btnA, 'hidden');
			removeClass(btnA, 'primary');
		} else if (autostartBusy) {
			$('autostart').textContent = '';
			removeClass(btnA, 'hidden');
			removeClass(btnA, 'primary');
			btnA.textContent = 'Working…';
		} else {
			$('autostart').textContent = '';
			removeClass(btnA, 'hidden');
			if (autostartOn) addClass(btnA, 'primary');
			else removeClass(btnA, 'primary');
			btnA.textContent = autostartOn ? 'Enabled' : 'Disabled';
		}
		// Show the Lampa shortcut when Lampa is installed. The startup scan yields
		// the exact app id to launch; the service's own fs check is a fallback so
		// the button still appears on TVs where the scan could not run.
		var lampaAvail = !!lampaAppId || !!s.lampaInstalled;
		$('btnLampa').className = 'btn' + (lampaAvail ? '' : ' hidden');
		var urls = s.accessUrls || [];
		firstUrl = urls.length ? urls[0] : null;
		$('urls').textContent = urls.length ? urls.join('    ') : 'http://<tv-ip>:' + (s.port || 8090);

		// Drive all action buttons (enabled/disabled + loading pulse) from status.
		updateButtons(s);

		// Footer shows a helpful tip based on the current status only. Transitional
		// states (starting/stopping/downloading…) keep whatever action message the
		// button press set, so progress feedback is not overwritten by a tip.
		if (st0.indexOf('error') === 0) {
			msg('Tip: open <b>Logs</b> to see what went wrong, then press <b>Start</b> to try again.');
		} else if (st0 === 'running') {
			msg('Tip: press <b>Open Web UI</b>, or manage TorrServer from any device at the Access URL above (login shown on the Auth row).');
		} else if (st0 === 'stopped') {
			msg('Tip: press <b>Start</b> to launch TorrServer.');
		}
	}

	// Refresh the live log view while polling, preserving the user's scroll
	// position unless they are already pinned to the bottom (tail-follow).
	function refreshLogsLive() {
		var w = $('logwrap');
		var atBottom = w.scrollHeight - w.clientHeight <= w.scrollTop + 20;
		svc('getLogs', { lines: LOG_LINES }, function (r) {
			$('logs').textContent = r.log;
			if (atBottom || w.scrollTop === 0) w.scrollTop = w.scrollHeight;
		});
	}

	var statusFailCount = 0;

	function poll() {
		svc(
			'status',
			{},
			function (s) {
				statusFailCount = 0;
				render(s);
				if (logsVisible) refreshLogsLive();
			},
			function () {
				// Never leave the UI silently stuck on "checking…". Transient
				// failures happen while the service respawns, so only surface a
				// message after several consecutive failures.
				statusFailCount++;
				if (statusFailCount >= 3) {
					$('state').className = 'v';
					$('state').textContent = 'service not responding';
					msg('Cannot reach the TorrServer service. Reopen the app; if it persists, reinstall from Homebrew Channel.');
				}
			}
		);
	}

	function startPolling() {
		poll();
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(poll, POLL_MS);
	}

	// Resume foreground activity after the app returns to the foreground.
	// Idempotent: only (re)starts timers that are not already running, then
	// restores D-pad focus so the screen is never left frozen.
	function resume() {
		if (!pollTimer) startPolling();
		var btns = visibleButtons();
		if (btns.length && (!document.activeElement || document.activeElement === document.body)) {
			btns[0].focus();
		}
	}

	// Pause all timers when the app leaves the foreground so it makes no
	// service calls while hidden.
	function pause() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// Handle a webOS relaunch (the user reselects the app while it is still
	// running in the background). With handlesRelaunch:true the system does NOT
	// bring us to the foreground automatically — the app must request it via
	// PalmSystem.activate(), otherwise clicking the launcher icon appears to do
	// nothing. This is the core fix for the "app won't reopen" bug.
	function onRelaunch() {
		try {
			if (window.PalmSystem && typeof window.PalmSystem.activate === 'function') {
				window.PalmSystem.activate();
			}
		} catch (e) {}
		resume();
	}

	// Register every foreground/background signal webOS may deliver so polling
	// and focus track the app's visibility reliably across TV models.
	function setupLifecycle() {
		function onVisibility() {
			if (document.hidden || document.webkitHidden || document.visibilityState === 'hidden') {
				pause();
			} else {
				resume();
			}
		}
		document.addEventListener('visibilitychange', onVisibility, false);
		document.addEventListener('webkitvisibilitychange', onVisibility, false);
		document.addEventListener('webOSRelaunch', onRelaunch, false);
		window.addEventListener('focus', resume, false);
		window.addEventListener('blur', pause, false);
		window.addEventListener('pageshow', resume, false);
		window.addEventListener('pagehide', pause, false);
	}

	function toggleLogs() {
		logsVisible = !logsVisible;
		$('logmodal').className = 'overlay' + (logsVisible ? '' : ' hidden');
		if (logsVisible) {
			$('logs').textContent = 'Loading…';
			$('btnLogClose').focus();
			svc('getLogs', { lines: LOG_LINES }, function (r) {
				if (!logsVisible) return;
				$('logs').textContent = r && r.log ? r.log : '(log is empty)';
				var w = $('logwrap');
				w.scrollTop = w.scrollHeight;
			});
		} else {
			var lb = $('btnLogs');
			var btns = visibleButtons();
			if (lb && btns.indexOf(lb) !== -1) lb.focus();
			else if (btns.length) btns[0].focus();
		}
	}

	// The currently focusable controls inside the open storage picker (the list
	// of storage buttons plus Cancel), used for D-pad up/down navigation.
	function pickerItems() {
		return Array.prototype.slice.call($('vpicker').getElementsByTagName('button')).filter(function (b) {
			return b.offsetParent !== null;
		});
	}

	function closeVersionPicker() {
		pickerOpen = false;
		$('vpicker').className = 'overlay hidden';
		var btns = visibleButtons();
		var sel = $(pickerReturnId);
		if (sel && btns.indexOf(sel) !== -1) sel.focus();
		else if (btns.length) btns[0].focus();
	}

	// Human-readable free space for the storage picker.
	function fmtBytes(n) {
		if (!n || n < 0) return '';
		var u = ['B', 'KB', 'MB', 'GB', 'TB'];
		var i = 0;
		while (n >= 1024 && i < u.length - 1) {
			n = n / 1024;
			i++;
		}
		return (i >= 2 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
	}

	function renderStorage(usb, current) {
		var list = $('vlist');
		list.innerHTML = '';
		// Internal (RAM) is always available and listed first, then each USB drive.
		var options = [{ path: '', label: 'Internal (RAM cache)', free: 0 }];
		for (var i = 0; i < usb.length; i++) {
			options.push({ path: usb[i].path, label: 'USB: ' + usb[i].path, free: usb[i].free });
		}
		for (var j = 0; j < options.length; j++) {
			(function (o) {
				// A chosen USB cache lives in a torrserver-cache/ subfolder, so match
				// on prefix to flag the drive currently in use.
				var inUse = o.path ? current.indexOf(o.path) === 0 : current === '';
				var b = document.createElement('button');
				b.className = 'vitem' + (inUse ? ' current' : '');
				var chips = '';
				if (inUse) chips += '<span class="chip-note installed">in use</span>';
				if (o.free) chips += '<span class="chip-note latest">' + fmtBytes(o.free) + ' free</span>';
				b.innerHTML = escapeHtml(o.label) + (chips ? '<span class="tag-notes">' + chips + '</span>' : '');
				b.onclick = function () {
					chooseStorage(o.path);
				};
				list.appendChild(b);
			})(options[j]);
		}
		var items = pickerItems();
		if (items.length) items[0].focus();
	}

	function openStoragePicker() {
		pickerOpen = true;
		pickerMode = 'storage';
		pickerReturnId = 'btnStorage';
		$('dlgTitle').textContent = 'Torrent cache storage';
		$('dlgSub').textContent = 'Store the torrent cache/downloads on a USB drive to save internal space. TorrServer itself stays on internal storage.';
		$('vpicker').className = 'overlay';
		$('vlist').textContent = 'Loading…';
		$('btnVCancel').focus();
		svc(
			'listStorage',
			{},
			function (r) {
				if (!pickerOpen) return;
				var usb = (r && r.usb) || [];
				var cur = (r && r.current) || '';
				if (!usb.length) {
					$('vlist').textContent = 'No USB drive detected — plug one into the TV and try again. The cache stays on internal storage (RAM) for now.';
					return;
				}
				renderStorage(usb, cur);
			},
			function () {
				$('vlist').textContent = 'Could not read storage — please try again.';
			}
		);
	}

	function chooseStorage(path) {
		// Compare against the drive currently in use (the cache lives in a subfolder).
		var same = path ? storageCurrent.indexOf(path) === 0 : storageCurrent === '';
		if (same) {
			closeVersionPicker();
			return;
		}
		var running = lastStatus.running === true;
		var where = path ? 'USB' : 'internal RAM cache';
		var m = running ? 'Moving the torrent cache to ' + where + '… TorrServer will restart.' : 'Cache set to ' + where + '. It will be used next time you start TorrServer.';
		beginAction('btnStorage', m, running);
		svc('setStorage', { path: path }, poll);
		closeVersionPicker();
	}

	function wire() {
		$('btnToggle').onclick = function () {
			if (isDisabled($('btnToggle'))) return;
			if (lastStatus.running === true) {
				beginAction('btnToggle', 'Stopping…', false);
				stopServer(poll);
			} else {
				beginAction('btnToggle', 'Starting…', true);
				svc('start', {}, poll);
			}
		};
		$('btnRestart').onclick = function () {
			if (isDisabled($('btnRestart'))) return;
			beginAction('btnRestart', 'Restarting…', true);
			svc('restart', {}, poll);
		};
		$('btnStorage').onclick = function () {
			if (isDisabled($('btnStorage'))) return;
			openStoragePicker();
		};
		$('btnVCancel').onclick = closeVersionPicker;
		$('btnAutostart').onclick = function () {
			if (isDisabled($('btnAutostart')) || autostartBusy) return;
			// On a rooted TV we manage the boot hook directly via the Homebrew
			// Channel (root exec) — reliable regardless of service elevation.
			if (hbRooted === true) {
				toggleAutostart();
				return;
			}
			if (!autostartAvailable) {
				msg('Autostart requires a rooted TV with the Homebrew Channel.');
				return;
			}
			// Fallback path: service is elevated but the Homebrew Channel is not
			// reachable — let the service manage its own hook.
			if (autostartOn) {
				msg('Disabling autostart…');
				svc('disableAutostart', {}, poll);
			} else {
				msg('Enabling autostart…');
				svc('enableAutostart', {}, poll);
			}
		};
		$('btnLogs').onclick = toggleLogs;
		$('btnLogClose').onclick = toggleLogs;
		$('btnLampa').onclick = function () {
			msg('Launching Lampa…');
			var id = lampaAppId || LAMPA_FALLBACK_ID;
			// Launch via the application manager from the app itself. The frontend
			// call carries our registered app identity, which the manager accepts -
			// no root needed.
			svc('launch', { id: id }, function () {}, function () {
				msg('Could not launch Lampa. Open it from the TV home screen.');
			}, APPMGR);
		};
		$('btnMedia').onclick = function () {
			msg('Launching media player…');
			svc('launchMediaPlayer', {});
		};
		$('btnOpen').onclick = function () {
			if (isDisabled($('btnOpen'))) return;
			if (!firstUrl) {
				msg('No network address yet — start the server first.');
				return;
			}
			msg('Opening the web UI in the TV browser…');
			// Launch the system browser at the TorrServer URL via the application
			// manager from the app itself (carries our registered identity). As a
			// last resort navigate our own webview so the page still opens.
			var launchParams = { id: BROWSER_ID, params: { target: firstUrl } };
			svc('launch', launchParams, function () {}, function () {
				window.location.href = firstUrl;
			}, APPMGR);
		};
	}

	// Run a shell command as root through the Homebrew Channel and hand back the
	// trimmed stdout. Used to manage the autostart boot hook on rooted TVs.
	function hbExec(command, onOut, onErr) {
		svc(
			'exec',
			{ command: command },
			function (res) {
				var out = (res && res.stdoutString) || '';
				if (onOut) onOut(out.replace(/^\s+|\s+$/g, ''));
			},
			function (e) {
				if (onErr) onErr(e);
			},
			HBCHANNEL
		);
	}

	// Stop the server through the service.
	function stopServer(done) {
		svc('stop', {}, done, done);
	}

	// Probe root once at startup. Autostart is managed by running the boot-hook
	// copy as root through the Homebrew Channel's `exec`, so the capability that
	// actually matters is "can we run a root command via hbchannel". We test that
	// directly by execing `id -u` and checking for uid 0. This is more reliable
	// than `checkRoot`, whose response shape varies across webOS versions (e.g.
	// webOS 4 returns {returnValue:true} with no `rooted` field), which is why
	// autostart wrongly showed as unavailable on rooted webOS 4 TVs.
	function probeRoot() {
		hbExec(
			'id -u',
			function (out) {
				if (out && out.replace(/\s+/g, '') === '0') {
					hbRooted = true;
					refreshHook();
				} else {
					hbRooted = false;
					notRooted = true;
				}
			},
			function () {
				hbRooted = false;
				notRooted = true;
			}
		);
	}

	// Fill the header with the TV firmware and webOS version once at startup.
	function loadDeviceInfo() {
		svc('getDeviceInfo', {}, function (r) {
			if (r && r.firmwareVersion) $('fwver').textContent = 'Firmware version: ' + r.firmwareVersion;
			if (r && r.webosVersion) $('osver').textContent = 'webOS version: ' + r.webosVersion;
		});
	}

	// Find the installed Lampa app (its id differs between builds, e.g. lampa.tv
	// vs com.lampa.tv) by listing the app directories as root once at startup.
	// Storing the exact id lets the Lampa button launch reliably and also drives
	// its visibility. Non-rooted TVs fall back to the service's fs check.
	function probeLampa() {
		hbExec(
			'for d in /media/developer/apps/usr/palm/applications/*lampa* ' +
				'/media/cryptofs/apps/usr/palm/applications/*lampa*; do ' +
				'[ -d "$d" ] && basename "$d"; done 2>/dev/null | head -1',
			function (out) {
				if (out) {
					lampaAppId = out;
					lampaChecked = true;
					poll();
				}
			},
			function () {}
		);
	}

	// Read whether the autostart boot hook is currently installed.
	function refreshHook() {
		hbExec(CHECK_CMD, function (out) {
			hookOn = out.indexOf('ON') === 0;
			hookKnown = true;
			// Keep an already-enabled hook current with this app version. Older
			// hooks launched TorrServer directly as root — which the jailed
			// service cannot stop — so silently re-copy the up-to-date hook.
			if (hookOn) hbExec(ENABLE_CMD, function () {});
		});
	}

	// Toggle autostart by writing/removing the boot hook as root. No service
	// elevation or reboot required — works on both old and new webOS.
	function toggleAutostart() {
		if (autostartBusy) return;
		autostartBusy = true;
		updateButtons(lastStatus); // instant loading pulse on the autostart button
		if (autostartOn) {
			msg('Disabling autostart…');
			hbExec(
				DISABLE_CMD,
				function () {
					hookOn = false;
					hookKnown = true;
					autostartBusy = false;
					msg('Autostart disabled.');
					poll();
				},
				function () {
					autostartBusy = false;
					msg('Could not update autostart. Please try again.');
					poll();
				}
			);
		} else {
			msg('Enabling autostart…');
			hbExec(
				ENABLE_CMD,
				function (out) {
					hookOn = out.indexOf('ENABLED') !== -1;
					hookKnown = true;
					autostartBusy = false;
					msg(hookOn ? 'Autostart enabled.' : 'Could not enable autostart — is the Homebrew Channel installed?');
					poll();
				},
				function () {
					autostartBusy = false;
					msg('Could not update autostart. Please try again.');
					poll();
				}
			);
		}
	}

	// D-pad navigation across the currently visible buttons (the Lampa shortcut
	// is hidden until Lampa is detected). Greyed/disabled buttons stay in the
	// cycle so focus never jumps unexpectedly; their onclick guards ignore the
	// press.
	function visibleButtons() {
		return Array.prototype.slice.call(document.querySelectorAll('.btn')).filter(function (b) {
			return b.offsetParent !== null;
		});
	}

	function setupNav() {
		// Start with focus on the primary action (Start) rather than the first
		// inline row button (Select version), so the most common action is where
		// the D-pad lands on open.
		var vis = visibleButtons();
		var start = $('btnToggle');
		if (start && vis.indexOf(start) !== -1) start.focus();
		else if (vis.length) vis[0].focus();

		document.addEventListener('keydown', function (e) {
			var k = e.keyCode;
			// While the version picker is open it captures navigation: up/down moves
			// through the release list, Back/Escape closes it.
			if (pickerOpen) {
				if (k === 38 || k === 40) {
					var items = pickerItems();
					if (!items.length) return;
					var pi = items.indexOf(document.activeElement);
					if (pi < 0) pi = 0;
					if (k === 38) pi = (pi + items.length - 1) % items.length;
					else pi = (pi + 1) % items.length;
					items[pi].focus();
					e.preventDefault();
				} else if (k === 461 || k === 27 || k === 8) {
					closeVersionPicker();
					e.preventDefault();
				}
				return;
			}
			// While the logs modal is open it captures navigation: up/down scroll
			// the log, Back/Escape close it.
			if (logsVisible) {
				var lw = $('logwrap');
				if (k === 38) {
					lw.scrollTop -= 90;
					e.preventDefault();
				} else if (k === 40) {
					lw.scrollTop += 90;
					e.preventDefault();
				} else if (k === 461 || k === 27 || k === 8) {
					toggleLogs();
					e.preventDefault();
				}
				return;
			}
			if (k === 37 || k === 39) {
				var btns = visibleButtons();
				if (!btns.length) return;
				var idx = btns.indexOf(document.activeElement);
				if (idx < 0) idx = 0;
				if (k === 37) idx = (idx + btns.length - 1) % btns.length;
				else idx = (idx + 1) % btns.length;
				btns[idx].focus();
				e.preventDefault();
			}
		});
	}

	window.addEventListener('load', function () {
		wire();
		// Reflect the safe "nothing running yet" state immediately, so Stop/
		// Restart/Open start greyed instead of looking active until the first
		// status poll (which can lag a few seconds while the service spawns).
		updateButtons();
		setupNav();
		setupLifecycle();
		startPolling();
		probeRoot();
		probeLampa();
		loadDeviceInfo();

		var xhr = new XMLHttpRequest();
		xhr.open('GET', 'appinfo.json', true);
		xhr.onload = function () {
			if (xhr.status === 200) {
				try {
					var info = JSON.parse(xhr.responseText);
					if (info.version) $('appversion').textContent = info.version;
				} catch (e) {}
			}
		};
		xhr.send();
	});
})();
