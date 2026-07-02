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
	var pickerOpen = false;
	var currentVersion = '';

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

	function setBadge(running, state) {
		var b = $('badge');
		state = state || '';
		if (running) {
			b.textContent = 'Running';
			b.className = 'badge running';
		} else if (state.indexOf('error') === 0) {
			b.textContent = 'Error';
			b.className = 'badge error';
		} else if (state === 'downloading' || state === 'starting') {
			b.textContent = state.charAt(0).toUpperCase() + state.slice(1) + '…';
			b.className = 'badge busy';
		} else {
			b.textContent = 'Stopped';
			b.className = 'badge stopped';
		}
	}

	function fmtMB(b) {
		var mb = b / 1048576;
		return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
	}

	function render(s) {
		s = s || {};
		setBadge(s.running, s.state);

		var stateText = s.state || (s.running ? 'running' : 'stopped');
		var dl = +s.downloadedBytes || 0;
		var tot = +s.totalBytes || 0;
		if (s.state === 'downloading') {
			if (tot > 0) {
				var pct = Math.max(0, Math.min(100, Math.round((dl / tot) * 100)));
				stateText = 'downloading ' + fmtMB(dl) + ' / ' + fmtMB(tot) + ' (' + pct + '%)';
			} else if (dl > 0) {
				stateText = 'downloading ' + fmtMB(dl) + '…';
			} else {
				stateText = 'downloading… (contacting GitHub)';
			}
		}
		$('state').textContent = stateText;
		$('version').textContent = s.version || '—';
		currentVersion = s.version || '';
		$('arch').textContent = s.arch || '—';
		$('datadir').textContent = s.dataDir || '—';
		// Autostart status. It can only be toggled when the service runs elevated
		// (rooted/Homebrew TV); otherwise the button is greyed out and skipped by
		// D-pad navigation because the boot hook cannot be written.
		autostartOn = !!s.autostart;
		autostartAvailable = s.autostartAvailable !== false;
		var btnA = $('btnAutostart');
		if (autostartAvailable) {
			$('autostart').textContent = autostartOn ? 'Enabled' : 'Disabled';
			btnA.textContent = 'Autostart: ' + (autostartOn ? 'On' : 'Off');
			btnA.disabled = false;
			btnA.className = 'btn';
		} else {
			$('autostart').textContent = 'Unavailable (TV not rooted)';
			btnA.textContent = 'Autostart: N/A';
			btnA.disabled = true;
			btnA.className = 'btn disabled';
		}
		// Show the Lampa shortcut only when the Lampa app is installed.
		$('btnLampa').className = 'btn' + (s.lampaInstalled ? '' : ' hidden');
		var urls = s.accessUrls || [];
		firstUrl = urls.length ? urls[0] : null;
		$('urls').textContent = urls.length ? urls.join('    ') : 'http://<tv-ip>:' + (s.port || 8090);

		if (s.state && s.state.indexOf('error') === 0) {
			msg('Failed: ' + s.state + ' — open <b>Logs</b> for details, then press <b>Start</b> to retry.');
		} else if (s.running) {
			msg('Running. Manage TorrServer from any device at the Access URL above.');
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

	function poll() {
		svc(
			'status',
			{},
			function (s) {
				render(s);
				if (logsVisible) refreshLogsLive();
			},
			function () {},
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
			var avail = r && r.updateAvailable;
			$('updatebadge').className = 'pill' + (avail ? '' : ' hidden');
			$('btnUpdate').className = 'btn' + (avail ? ' attention' : '');
			if (avail) {
				$('btnUpdate').textContent = 'Update to ' + r.latest;
				msg('A new TorrServer version (<b>' + r.latest + '</b>) is available. Press <b>Update</b> to install.');
			}
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

	function renderVersions(versions) {
		var list = $('vlist');
		list.innerHTML = '';
		if (!versions.length) {
			list.textContent = 'No versions available — check your network and try again.';
			return;
		}
		for (var i = 0; i < versions.length; i++) {
			(function (tag, idx) {
				var isCurrent = tag === currentVersion;
				var b = document.createElement('button');
				b.className = 'vitem' + (isCurrent ? ' current' : '');
				var note = isCurrent ? 'installed' : idx === 0 ? 'latest' : '';
				b.innerHTML = escapeHtml(tag) + (note ? '<span class="tag-note">' + note + '</span>' : '');
				b.onclick = function () {
					chooseVersion(tag);
				};
				list.appendChild(b);
			})(versions[i], i);
		}
		var items = pickerItems();
		if (items.length) items[0].focus();
	}

	function openVersionPicker() {
		pickerOpen = true;
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
			},
		);
	}

	function closeVersionPicker() {
		pickerOpen = false;
		$('vpicker').className = 'overlay hidden';
		var btns = visibleButtons();
		var sel = $('btnSelectVersion');
		if (sel && btns.indexOf(sel) !== -1) sel.focus();
		else if (btns.length) btns[0].focus();
	}

	function chooseVersion(tag) {
		if (tag === currentVersion) {
			msg('TorrServer <b>' + escapeHtml(tag) + '</b> is already installed.');
			closeVersionPicker();
			return;
		}
		msg('Installing TorrServer <b>' + escapeHtml(tag) + '</b>… this can take a minute.');
		svc('selectVersion', { version: tag }, poll);
		closeVersionPicker();
		setTimeout(checkUpdate, 60000);
	}

	function wire() {
		$('btnStart').onclick = function () {
			msg('Starting… first launch downloads TorrServer (~70&nbsp;MB), this can take a minute.');
			svc('start', {}, poll);
		};
		$('btnStop').onclick = function () {
			msg('Stopping…');
			svc('stop', {}, poll);
		};
		$('btnRestart').onclick = function () {
			msg('Restarting…');
			svc('restart', {}, poll);
		};
		$('btnUpdate').onclick = function () {
			msg('Updating to the latest TorrServer release…');
			svc('update', {}, poll);
			setTimeout(checkUpdate, 60000);
		};
		$('btnSelectVersion').onclick = openVersionPicker;
		$('btnVCancel').onclick = closeVersionPicker;
		$('btnAutostart').onclick = function () {
			if (!autostartAvailable) {
				msg('Autostart requires a rooted TV with the Homebrew Channel.');
				return;
			}
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
			svc('launchLampa', {});
		};
		$('btnMedia').onclick = function () {
			msg('Launching media player…');
			svc('launchMediaPlayer', {});
		};
		$('btnOpen').onclick = function () {
			if (firstUrl) {
				window.location.href = firstUrl;
			} else {
				msg('No network address yet — start the server first.');
			}
		};
	}

	// D-pad navigation across the currently visible, enabled buttons only (the
	// Lampa shortcut is hidden until Lampa is detected, and the Autostart button
	// is disabled/greyed on non-rooted TVs).
	function visibleButtons() {
		return Array.prototype.slice.call(document.querySelectorAll('.btn')).filter(function (b) {
			return b.offsetParent !== null && !b.disabled;
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
		setupNav();
		setupLifecycle();
		startPolling();
		checkUpdate();
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
