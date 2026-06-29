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

	function msg(text) {
		$('msg').innerHTML = text || '';
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
		$('arch').textContent = s.arch || '—';
		$('datadir').textContent = s.dataDir || '—';
		// Autostart status
		autostartOn = !!s.autostart;
		$('autostart').textContent = autostartOn ? 'Enabled' : 'Disabled';
		$('btnAutostart').textContent = 'Autostart: ' + (autostartOn ? 'On' : 'Off');
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
		$('btnAutostart').onclick = function () {
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

	// D-pad navigation across the currently visible buttons only (the Lampa
	// shortcut is hidden until the Lampa app is detected).
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
