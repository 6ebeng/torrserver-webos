(function () {
	'use strict';

	var SERVICE = 'com.torrserver.app.service';
	var POLL_MS = 2000;
	var LOG_LINES = 300;

	function $(id) {
		return document.getElementById(id);
	}

	var pollTimer = null;
	var updateTimer = null;
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
	var pickerReturnId = 'btnSelectVersion'; // button to refocus when the picker closes
	var pickerMode = 'version'; // 'version' | 'storage'
	var storageCurrent = ''; // current torrent-cache path ('' = internal RAM)
	var currentVersion = '';
	var updateAvailable = false; // a newer TorrServer release is available to install
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

	function fmtMB(b) {
		var mb = b / 1048576;
		return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
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

		setBtnDisabled($('btnStart'), running || busy);
		setBtnDisabled($('btnStop'), !running || busy);
		setBtnDisabled($('btnRestart'), !running || busy);
		setBtnDisabled($('btnSelectVersion'), busy);
		setBtnDisabled($('btnStorage'), busy);
		setBtnDisabled($('btnOpen'), !running || !firstUrl);
		setBtnDisabled($('btnUpdate'), !updateAvailable || busy);
		setBtnDisabled($('btnAutostart'), !autostartAvailable || autostartBusy || busy);

		// Highlight Update only when there is genuinely something to install.
		if (updateAvailable && !busy) addClass($('btnUpdate'), 'attention');
		else removeClass($('btnUpdate'), 'attention');

		// Pulse the pressed button (and the autostart toggle while it works).
		var ids = ['btnStart', 'btnStop', 'btnRestart', 'btnUpdate', 'btnAutostart', 'btnSelectVersion', 'btnStorage'];
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
		var dl = +s.downloadedBytes || 0;
		var tot = +s.totalBytes || 0;
		var stateText;
		if (st0 === 'downloading' || st0 === 'updating' || st0 === 'installing') {
			var verb = st0 === 'downloading' ? 'Downloading' : st0 === 'updating' ? 'Updating' : 'Installing';
			if (tot > 0) {
				var pct = Math.max(0, Math.min(100, Math.round((dl / tot) * 100)));
				stateText = verb + ' ' + fmtMB(dl) + ' / ' + fmtMB(tot) + ' (' + pct + '%)';
			} else if (dl > 0) {
				stateText = verb + ' ' + fmtMB(dl) + '…';
			} else {
				stateText = verb + '… (contacting GitHub)';
			}
		} else if (st0 === 'starting') {
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
		// When the installed version actually changes (an update or a manual
		// version pick just finished), re-check upstream right away so the
		// "update available" badge/button and version chip reflect the new
		// build instead of lingering stale until the 30-minute timer fires.
		var prevVersion = currentVersion;
		currentVersion = s.version || '';
		if (currentVersion && prevVersion && currentVersion !== prevVersion) {
			checkUpdate();
		}
		$('arch').textContent = s.arch || '—';
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
		if (autostartBusy) {
			$('autostart').textContent = 'Working…';
			btnA.textContent = 'Autostart: …';
		} else if (autostartAvailable) {
			$('autostart').textContent = autostartOn ? 'Enabled' : 'Disabled';
			btnA.textContent = 'Autostart: ' + (autostartOn ? 'On' : 'Off');
		} else {
			$('autostart').textContent = 'Unavailable (TV not rooted)';
			btnA.textContent = 'Autostart: N/A';
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
			msg('Tip: press <b>Open Web UI</b>, or manage TorrServer from any device at the Access URL above.');
		} else if (st0 === 'stopped') {
			msg('Tip: press <b>Start</b> to launch TorrServer. The first launch downloads it automatically (~70 MB).');
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
		if (!updateTimer) {
			checkUpdate();
			updateTimer = setInterval(checkUpdate, 30 * 60 * 1000);
		}
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
		if (updateTimer) {
			clearInterval(updateTimer);
			updateTimer = null;
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

	function checkUpdate() {
		svc('checkUpdate', {}, function (r) {
			updateAvailable = !!(r && r.updateAvailable);
			$('updatebadge').className = 'pill' + (updateAvailable ? '' : ' hidden');
			if (updateAvailable) {
				$('btnUpdate').textContent = 'Update to ' + r.latest;
				msg('A new TorrServer version (<b>' + r.latest + '</b>) is available. Press <b>Update</b> to install.');
			} else {
				$('btnUpdate').textContent = 'Update server';
			}
			// Let the centralised logic grey/highlight the Update button.
			updateButtons(lastStatus);
		});
	}

	function toggleLogs() {
		logsVisible = !logsVisible;
		$('logwrap').className = 'card' + (logsVisible ? '' : ' hidden');
		if (logsVisible) {
			$('logs').textContent = 'Loading…';
			svc('getLogs', { lines: LOG_LINES }, function (r) {
				$('logs').textContent = r && r.log ? r.log : '(log is empty)';
			});
		}
	}

	// The currently focusable controls inside the open version picker (the list
	// of release buttons plus Cancel), used for D-pad up/down navigation.
	function pickerItems() {
		return Array.prototype.slice.call($('vpicker').getElementsByTagName('button')).filter(function (b) {
			return b.offsetParent !== null;
		});
	}

	// The service returns either objects ({tag, prerelease}) or, from an older
	// cache, bare tag strings. Normalise both so the picker code is uniform.
	function normalizeVersion(v) {
		if (typeof v === 'string') return { tag: v, prerelease: false };
		return { tag: v.tag, prerelease: !!v.prerelease };
	}

	function renderVersions(versions) {
		var list = $('vlist');
		list.innerHTML = '';
		if (!versions.length) {
			list.textContent = 'No versions available — check your network and try again.';
			return;
		}
		// "Latest" belongs to the newest STABLE (non-prerelease) release, matching
		// GitHub's own "Latest" label — not simply the first entry, which may be a
		// pre-release.
		var latestStableTag = null;
		for (var k = 0; k < versions.length; k++) {
			var vk = normalizeVersion(versions[k]);
			if (!vk.prerelease) {
				latestStableTag = vk.tag;
				break;
			}
		}
		for (var i = 0; i < versions.length; i++) {
			(function (v) {
				var tag = v.tag;
				var isCurrent = tag === currentVersion;
				var b = document.createElement('button');
				b.className = 'vitem' + (isCurrent ? ' current' : '');
				var chips = '';
				if (isCurrent) chips += '<span class="chip-note installed">installed</span>';
				if (v.prerelease) {
					chips += '<span class="chip-note pre">pre-release</span>';
				} else if (tag === latestStableTag) {
					chips += '<span class="chip-note latest">latest</span>';
				}
				b.innerHTML = escapeHtml(tag) + (chips ? '<span class="tag-notes">' + chips + '</span>' : '');
				b.onclick = function () {
					chooseVersion(tag);
				};
				list.appendChild(b);
			})(normalizeVersion(versions[i]));
		}
		var items = pickerItems();
		if (items.length) items[0].focus();
	}

	function openVersionPicker() {
		pickerOpen = true;
		pickerMode = 'version';
		pickerReturnId = 'btnSelectVersion';
		$('dlgTitle').textContent = 'Select TorrServer version';
		$('dlgSub').textContent = 'Pick a release to install. Use this to downgrade if the latest build has issues.';
		$('vpicker').className = 'overlay';
		$('vlist').textContent = 'Loading…';
		$('btnVCancel').focus();
		svc(
			'listVersions',
			{},
			function (r) {
				if (!pickerOpen) return;
				renderVersions((r && r.versions) || []);
			},
			function () {
				$('vlist').textContent = 'Could not load versions — check your network and try again.';
			}
		);
	}

	function closeVersionPicker() {
		pickerOpen = false;
		$('vpicker').className = 'overlay hidden';
		var btns = visibleButtons();
		var sel = $(pickerReturnId);
		if (sel && btns.indexOf(sel) !== -1) sel.focus();
		else if (btns.length) btns[0].focus();
	}

	function chooseVersion(tag) {
		if (tag === currentVersion) {
			msg('TorrServer <b>' + escapeHtml(tag) + '</b> is already installed.');
			closeVersionPicker();
			return;
		}
		beginAction('btnSelectVersion', 'Installing TorrServer <b>' + escapeHtml(tag) + '</b>… this can take a minute.', true);
		svc('selectVersion', { version: tag }, poll);
		closeVersionPicker();
		setTimeout(checkUpdate, 60000);
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
		var m = running
			? 'Moving the torrent cache to ' + where + '… TorrServer will restart.'
			: 'Cache set to ' + where + '. It will be used next time you start TorrServer.';
		beginAction('btnStorage', m, running);
		svc('setStorage', { path: path }, poll);
		closeVersionPicker();
	}

	function wire() {
		$('btnStart').onclick = function () {
			if (isDisabled($('btnStart'))) return;
			beginAction('btnStart', 'Starting… first launch downloads TorrServer (~70&nbsp;MB), this can take a minute.', true);
			svc('start', {}, poll);
		};
		$('btnStop').onclick = function () {
			if (isDisabled($('btnStop'))) return;
			beginAction('btnStop', 'Stopping…', false);
			stopServer(poll);
		};
		$('btnRestart').onclick = function () {
			if (isDisabled($('btnRestart'))) return;
			beginAction('btnRestart', 'Restarting…', true);
			// Clear any root-owned instance first so the (jailed) service can
			// cleanly restart its own instance instead of seeing it "running".
			rootKill(function () {
				svc('restart', {}, poll);
			});
		};
		$('btnUpdate').onclick = function () {
			if (isDisabled($('btnUpdate'))) return;
			beginAction('btnUpdate', 'Updating to the latest TorrServer release…', true);
			// Clear the badge right away instead of waiting for the next check.
			$('updatebadge').className = 'pill hidden';
			svc('update', {}, poll);
			setTimeout(checkUpdate, 60000);
		};
		$('btnSelectVersion').onclick = function () {
			if (isDisabled($('btnSelectVersion'))) return;
			openVersionPicker();
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
		$('btnLampa').onclick = function () {
			msg('Launching Lampa…');
			var id = lampaAppId || LAMPA_FALLBACK_ID;
			var failed = function () {
				msg('Could not launch Lampa. Open it from the TV home screen.');
			};
			// Launching an app is rejected from the jailed service and from the
			// frontend's limited role on webOS 9, but a root luna-send (via the
			// Homebrew Channel, the same path we use for autostart) works. Fall
			// back to a direct frontend launch for non-rooted / older TVs.
			var frontendLaunch = function () {
				svc('launch', { id: id }, function () {}, failed, APPMGR);
			};
			hbExec(
				'luna-send -n 1 luna://com.webos.applicationManager/launch \'{"id":"' + id + '"}\'',
				function (out) {
					if (/"returnValue"\s*:\s*true/.test(out)) return;
					frontendLaunch();
				},
				frontendLaunch
			);
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
			// Launch the system browser at the TorrServer URL. A root luna-send
			// (via the Homebrew Channel) is the most reliable path on webOS 9;
			// fall back to a frontend launch, then finally to navigating our own
			// webview so the page still opens on TVs where neither launch works.
			var launchParams = { id: BROWSER_ID, params: { target: firstUrl } };
			var inWebview = function () {
				window.location.href = firstUrl;
			};
			var frontendLaunch = function () {
				svc('launch', launchParams, function () {}, inWebview, APPMGR);
			};
			hbExec(
				'luna-send -n 1 luna://com.webos.applicationManager/launch \'{"id":"' + BROWSER_ID + '","params":{"target":"' + firstUrl + '"}}\'',
				function (out) {
					if (/"returnValue"\s*:\s*true/.test(out)) return;
					frontendLaunch();
				},
				frontendLaunch
			);
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

	// Kill any TorrServer left running as root by the boot hook: a jailed service
	// runs as a normal user and cannot signal a root-owned process, so Stop would
	// otherwise silently do nothing. A no-op on non-rooted TVs.
	function rootKill(done) {
		if (hbRooted !== true) {
			if (done) done();
			return;
		}
		hbExec(
			'pkill -9 -x TorrServer 2>/dev/null; rm -f /media/developer/torrserver/torrserver.pid 2>/dev/null; echo stopped > /media/developer/torrserver/state 2>/dev/null; echo DONE',
			function () {
				if (done) done();
			},
			function () {
				if (done) done();
			}
		);
	}

	// Stop the server through the (jailed) service, then make sure no root-owned
	// instance survives on a rooted TV.
	function stopServer(done) {
		svc(
			'stop',
			{},
			function () {
				rootKill(done);
			},
			function () {
				rootKill(done);
			}
		);
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
		var first = visibleButtons();
		if (first.length) first[0].focus();

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
			if (k === 37 || k === 39) {
				var btns = visibleButtons();
				if (!btns.length) return;
				var idx = btns.indexOf(document.activeElement);
				if (idx < 0) idx = 0;
				if (k === 37) idx = (idx + btns.length - 1) % btns.length;
				else idx = (idx + 1) % btns.length;
				btns[idx].focus();
				e.preventDefault();
			} else if (k === 461 || k === 27) {
				if (logsVisible) {
					toggleLogs();
					e.preventDefault();
				}
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
		checkUpdate();
		probeRoot();
		probeLampa();
		loadDeviceInfo();
		updateTimer = setInterval(checkUpdate, 30 * 60 * 1000);

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
