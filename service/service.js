/*
 * TorrServer control service for webOS.
 *
 * This is a thin Luna-bus wrapper around torrserver-run.sh, which does the heavy
 * lifting (architecture detection, download, process supervision). Long-running
 * actions (start / install / update / restart) are launched detached and the
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
var AUTOSTART_HOOK = '/var/lib/webosbrew/init.d/torrserver';
var LAMPA_ID = 'com.lampa.tv';
var LAMPA_DIRS = ['/media/developer/apps/usr/palm/applications/com.lampa.tv', '/media/cryptofs/apps/usr/palm/applications/com.lampa.tv'];

var service = new Service(SERVICE_ID);

// Make sure the control script is executable after install.
try {
	fs.chmodSync(SCRIPT, parseInt('0755', 8));
} catch (e) {
	/* ignore */
}

function runScript(args, timeoutMs, cb) {
	child.execFile('sh', [SCRIPT].concat(args), { timeout: timeoutMs || 0, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout, stderr) {
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
	child.execFile('luna-send', ['-n', '1', '-f', uri, JSON.stringify(payload || {})], { timeout: 10000 }, function () {
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
		// Check if the autostart init script exists (script also reports this;
		// re-check here as a fallback in case the JSON failed to parse).
		try {
			data.autostart = fs.existsSync(AUTOSTART_HOOK);
		} catch (e) {
			/* keep value from script */
		}
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
registerAsyncAction('update', 'update', 'updating');
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

service.register('checkUpdate', function (message) {
	runScript(['latest'], 20000, function (err, stdout) {
		var latest = String(stdout || '').trim();
		readStatus(function (data) {
			var installed = data.version || '';
			var avail = !!(latest && installed && latest !== installed);
			message.respond({ returnValue: true, installed: installed, latest: latest, updateAvailable: avail });
		});
	});
});

// Called by the autostart hook (luna://.../autostart) at boot.
registerAsyncAction('autostart', 'start', 'started');

service.register('enableAutostart', function (message) {
	runScript(['enable-autostart'], 15000, function () {
		message.respond({ returnValue: true, autostart: true });
	});
});

service.register('disableAutostart', function (message) {
	runScript(['disable-autostart'], 15000, function () {
		message.respond({ returnValue: true, autostart: false });
	});
});

// TorrServer-specific quick launchers, preserving the original app's shortcuts.
service.register('launchLampa', function (message) {
	lunaSend('luna://com.webos.applicationManager/launch', { id: LAMPA_ID }, function () {
		message.respond({ returnValue: true, launched: true, app: LAMPA_ID });
	});
});

service.register('launchMediaPlayer', function (message) {
	// webOS < 6 exposes the media player as "Photo/Video" (photovideo); webOS 6+
	// renamed it to "MediaPlayer" (mediadiscovery). Pick by the SDK major version.
	child.execFile('luna-send', ['-n', '1', '-f', 'luna://com.webos.service.tv.systemproperty/getSystemInfo', '{"keys":["sdkVersion"]}'], { timeout: 10000 }, function (err, stdout) {
		var major = 0;
		try {
			var j = JSON.parse(String(stdout || '{}'));
			major = parseInt(String(j.sdkVersion || '0').split('.')[0], 10) || 0;
		} catch (e) {
			/* default to legacy id */
		}
		var appId = major >= 6 ? 'com.webos.app.mediadiscovery' : 'com.webos.app.photovideo';
		lunaSend('luna://com.webos.applicationManager/launch', { id: appId }, function () {
			message.respond({ returnValue: true, launched: true, app: appId });
		});
	});
});

// Keep the service resident. webOS shuts a JS service down as soon as it holds
// no active "activity" - the launcher logs "no active activities, exiting" and
// the process can die before (or between) Luna calls are delivered. Holding one
// activity open from startup keeps the service alive and responsive so the TV UI
// can reliably call status/start/stop and poll download progress.
function keepAlive() {
	try {
		service.activityManager.create('torrserver-keepalive', function (activity) {
			// Intentionally never completed -> the service stays alive.
		});
	} catch (e) {
		// If activity creation is unavailable, fall back to a no-op timer so the
		// Node event loop at least stays alive within a single launch.
		setInterval(function () {}, 60000);
	}
}
keepAlive();
