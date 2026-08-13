/*
 * TorrServer control service for webOS.
 *
 * This is a thin Luna-bus wrapper around torrserver-run.sh, which does the heavy
 * lifting (installing the bundled binary and supervising the process). Long-
 * running actions (start / install / restart) are launched detached and the
 * front-end polls "status" to follow progress, so Luna calls never block.
 *
 * Written in ES5 for compatibility with the older Node runtimes shipped on
 * various webOS versions.
 */
/* eslint-disable */
var Service = require('webos-service');
var path = require('path');
var fs = require('fs');
var os = require('os');
var child = require('child_process');

var SERVICE_ID = 'com.torrserver.app.service';
var PORT = 8090;
var SCRIPT = path.join(__dirname, 'torrserver-run.sh');
var LAMPA_ID = 'com.lampa.tv';
var LAMPA_DIRS = [
	'/media/developer/apps/usr/palm/applications/com.lampa.tv',
	'/media/cryptofs/apps/usr/palm/applications/com.lampa.tv',
	'/media/developer/apps/usr/palm/applications/lampa.tv',
	'/media/cryptofs/apps/usr/palm/applications/lampa.tv',
];

// idleTimer (seconds): webos-service exits this on-demand service through its
// normal clean path this many seconds after the last Luna call (which properly
// de-registers the Luna name). The front-end polls every ~2s so the service
// stays alive and responsive while the app is open, then exits on its own when
// the app closes. See the note where keepAlive() used to be for why staying
// resident is harmful.
var service = new Service(SERVICE_ID, null, { idleTimer: 10 });

// Make sure the control script is executable after install.
try {
	fs.chmodSync(SCRIPT, parseInt('0755', 8));
} catch (e) {
	/* ignore */
}

// Spawn a child process without ever throwing.
//
// When the app is installed WITHOUT Homebrew elevation (plain Developer Mode /
// webOS Dev Manager, or any unrooted TV) this service runs inside a jail that
// forbids executing some binaries - notably `luna-send`. On the old Node 0.12
// runtime child_process.execFile reports that as a SYNCHRONOUS `throw` ( Error:
// spawn EACCES ), not as a callback error. An uncaught throw kills the whole
// service process, so every in-flight Luna call dies unanswered and the app is
// left showing "checking status" forever. Routing the failure to the callback
// keeps the service alive and lets each method degrade gracefully.
function safeExecFile(file, args, opts, cb) {
	try {
		return child.execFile(file, args, opts, cb);
	} catch (e) {
		setTimeout(function () {
			cb(e, '', String((e && e.message) || e));
		}, 0);
		return null;
	}
}

function runScript(args, timeoutMs, cb) {
	safeExecFile('sh', [SCRIPT].concat(args), { timeout: timeoutMs || 0, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout, stderr) {
		cb(err, String(stdout || ''), String(stderr || ''));
	});
}

function accessUrls() {
	var urls = [];
	try {
		var ifaces = os.networkInterfaces();
		Object.keys(ifaces).forEach(function (name) {
			(ifaces[name] || []).forEach(function (i) {
				var v4 = i.family === 'IPv4' || i.family === 4;
				if (v4 && !i.internal && i.address && i.address.indexOf('169.254.') !== 0) {
					urls.push('http://' + i.address + ':' + PORT);
				}
			});
		});
	} catch (e) {
		/* ignore */
	}
	return urls;
}

function lampaInstalled() {
	for (var i = 0; i < LAMPA_DIRS.length; i++) {
		try {
			if (fs.existsSync(LAMPA_DIRS[i])) return true;
		} catch (e) {
			/* ignore */
		}
	}
	return false;
}

function lunaSend(uri, payload, cb) {
	safeExecFile('luna-send', ['-n', '1', '-f', uri, JSON.stringify(payload || {})], { timeout: 10000 }, function () {
		if (cb) cb();
	});
}

function readStatus(cb) {
	runScript(['status'], 15000, function (err, stdout) {
		var data = { running: false, installed: false, state: 'unknown', port: PORT };
		var lines = stdout.trim().split('\n');
		var last = lines.length ? lines[lines.length - 1] : '';
		try {
			data = JSON.parse(last);
		} catch (e) {
			/* keep default */
		}
		data.accessUrls = accessUrls();
		data.lampaInstalled = lampaInstalled();
		// The `autostart` field comes from the control script, which checks the
		// real boot hook through hbchannel (root, host namespace). We must NOT
		// re-check it here with fs.existsSync: this service runs inside a jail
		// with a private mount namespace and cannot see /var/lib/webosbrew.
		data.returnValue = true;
		cb(data);
	});
}

service.register('status', function (message) {
	readStatus(function (data) {
		message.respond(data);
	});
});

// Fire-and-forget actions. The control script self-backgrounds the real work
// (setsid), so a plain execFile returns at once while the worker keeps running.
// We deliberately do NOT use Node's spawn({detached:true}) here: on webOS the
// service is torn down right after responding and takes the detached child with
// it, so the action silently never runs (state stays "stopped", nothing is
// downloaded). The front-end follows progress by polling "status".
function registerAsyncAction(method, scriptArg, ackKey) {
	service.register(method, function (message) {
		runScript([scriptArg], 15000, function () {
			var res = { returnValue: true };
			res[ackKey] = true;
			message.respond(res);
		});
	});
}

registerAsyncAction('start', 'start', 'started');
registerAsyncAction('install', 'install', 'installing');
registerAsyncAction('restart', 'restart', 'restarting');

service.register('stop', function (message) {
	runScript(['stop'], 30000, function () {
		message.respond({ returnValue: true, stopped: true });
	});
});

service.register('getLogs', function (message) {
	var lines = (message.payload && message.payload.lines) || 200;
	runScript(['logs', String(lines)], 15000, function (err, stdout) {
		message.respond({ returnValue: true, log: stdout });
	});
});

// Called by the autostart hook (luna://.../autostart) at boot.
registerAsyncAction('autostart', 'start', 'started');

service.register('enableAutostart', function (message) {
	runScript(['enable-autostart'], 25000, function (err, stdout) {
		var ok = String(stdout || '').indexOf('enabled') !== -1;
		message.respond({ returnValue: true, autostart: ok });
	});
});

service.register('disableAutostart', function (message) {
	runScript(['disable-autostart'], 25000, function (err, stdout) {
		var off = String(stdout || '').indexOf('disabled') !== -1;
		message.respond({ returnValue: true, autostart: !off });
	});
});

// TorrServer-specific quick launchers, preserving the original app's shortcuts.
service.register('launchLampa', function (message) {
	// The frontend passes the exact app id it resolved from the launch points;
	// fall back to the common id if it did not. (This path is mainly for older
	// webOS where a service is permitted to launch apps.)
	var id = (message.payload && message.payload.id) || LAMPA_ID;
	lunaSend('luna://com.webos.applicationManager/launch', { id: id }, function () {
		message.respond({ returnValue: true, launched: true, app: id });
	});
});

service.register('launchMediaPlayer', function (message) {
	// webOS < 6 exposes the media player as "Photo/Video" (photovideo); webOS 6+
	// renamed it to "MediaPlayer" (mediadiscovery). Pick by the major version,
	// read from the nyx info file (no subprocess, so it works jailed too).
	var major = parseInt(String(readDeviceInfo().webosVersion || '0').split('.')[0], 10) || 0;
	var appId = major >= 6 ? 'com.webos.app.mediadiscovery' : 'com.webos.app.photovideo';
	lunaSend('luna://com.webos.applicationManager/launch', { id: appId }, function () {
		message.respond({ returnValue: true, launched: true, app: appId });
	});
});

// Report the TV's firmware and webOS version so the header can show them.
//
// These come straight from the nyx info files, which are world-readable, so this
// works even when the service is jailed (unrooted / non-elevated install). We
// deliberately do NOT shell out to luna-send here: a jail forbids executing it,
// which used to crash the whole service. Values never change at runtime, so the
// result is read once and cached.
var deviceInfoCache = null;

function readDeviceInfo() {
	if (deviceInfoCache) return deviceInfoCache;
	var info = { firmwareVersion: '', webosVersion: '', modelName: '' };
	try {
		var oi = JSON.parse(fs.readFileSync('/var/run/nyx/os_info.json', 'utf8'));
		info.firmwareVersion = String(oi.webos_manufacturing_version || '');
		info.webosVersion = String(oi.webos_release || '');
	} catch (e) {
		/* not a TV / file missing */
	}
	try {
		var di = JSON.parse(fs.readFileSync('/var/run/nyx/device_info.json', 'utf8'));
		info.modelName = String(di.product_id || '');
	} catch (e) {
		/* not a TV / file missing */
	}
	if (info.firmwareVersion || info.webosVersion || info.modelName) deviceInfoCache = info;
	return info;
}

service.register('getDeviceInfo', function (message) {
	var info = readDeviceInfo();
	message.respond({
		returnValue: true,
		firmwareVersion: info.firmwareVersion,
		webosVersion: info.webosVersion,
		modelName: info.modelName,
	});
});

// List USB storage the torrent disk-cache can use, plus the current cache path.
// An empty `current` means the default in-RAM cache (internal storage).
service.register('listStorage', function (message) {
	runScript(['list-usb'], 15000, function (err, stdout) {
		var usb = String(stdout || '')
			.split('\n')
			.map(function (l) {
				return l.replace(/^\s+|\s+$/g, '');
			})
			.filter(function (l) {
				return l.length > 0;
			})
			.map(function (l) {
				var p = l.split('|');
				return { path: p[0], free: (parseInt(p[1], 10) || 0) * 1024 };
			});
		runScript(['cache'], 8000, function (e2, cur) {
			message.respond({ returnValue: true, usb: usb, current: String(cur || '').replace(/^\s+|\s+$/g, '') });
		});
	});
});

// Move the torrent cache/downloads to a USB path (or "" / "ram" for the internal
// RAM cache). The control script self-backgrounds the restart, so we ack at once
// and the UI follows progress via status polling.
service.register('setStorage', function (message) {
	var p = (message.payload && message.payload.path) || '';
	runScript(['set-storage', String(p)], 15000, function () {
		message.respond({ returnValue: true, setting: true });
	});
});

// Explicitly de-register from the Luna bus on every exit path so ls-hubd frees
// our service name immediately. This is the key to surviving app updates.
//
// webOS runs this as an on-demand ("dynamic") service and webos-service's
// ActivityManager exits it cleanly a few seconds (idleTimer, set above) after
// the last Luna call. The front-end polls status every ~2s, so the service
// stays alive while the app is open and exits on its own once the app closes -
// it is never a resident process. That matters for updates: installing a new
// .ipk over a *resident* service kills it abruptly, and ls-hubd keeps
// advertising the now-dead PID (a "ghost" that hangs every future call, UI
// stuck on "checking status", until reboot).
//
// But an elevated (hbchannel) service adds an extra launcher process that
// breaks ls-hubd's automatic socket-close detection, so even a clean exit can
// ghost. To avoid that we de-register our bus handle(s) explicitly on exit,
// which tells ls-hubd to free the name right away so the next call relaunches a
// fresh instance. Long-running work (download / start) is detached inside
// torrserver-run.sh via setsid, so it keeps running after this service exits.
function deregister() {
	var handles = [service.handle, service.privateHandle, service.publicHandle];
	for (var i = 0; i < handles.length; i++) {
		try {
			if (handles[i] && typeof handles[i].unregister === 'function') handles[i].unregister();
		} catch (e) {
			/* ignore */
		}
	}
}
process.on('exit', deregister);
process.on('SIGTERM', function () {
	process.exit(0);
});
process.on('SIGINT', function () {
	process.exit(0);
});

// Last-resort guard: never let one failing call take the whole service down.
//
// If the process dies mid-request, every in-flight Luna call goes unanswered and
// the app hangs on "checking status" until the TV is rebooted - a far worse
// outcome than one method returning nothing. Staying alive lets the next poll
// succeed. (This caught a real case: a jailed service throwing "spawn EACCES"
// because it is not allowed to execute luna-send.)
process.on('uncaughtException', function (e) {
	try {
		console.error('uncaught exception (service kept alive): ' + ((e && e.stack) || e));
	} catch (e2) {
		/* ignore */
	}
});
