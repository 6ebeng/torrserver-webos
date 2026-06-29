/*
 * Minimal Luna service bridge for webOS web apps.
 * Uses the built-in PalmServiceBridge (present in webOS WebViews) so the app
 * has no external runtime dependencies.
 */
(function (global) {
	'use strict';

	function call(serviceId, method, params, opts) {
		opts = opts || {};
		var uri = 'luna://' + serviceId + '/' + method;

		if (typeof global.PalmServiceBridge === 'undefined') {
			if (opts.onFailure) {
				opts.onFailure({ returnValue: false, errorText: 'PalmServiceBridge unavailable (not a webOS TV)' });
			}
			return null;
		}

		var bridge = new global.PalmServiceBridge();
		var done = false;
		var subscribed = !!(params && (params.subscribe || params.watch));

		function release() {
			// One-shot Luna calls must be released, otherwise the underlying bus
			// connection leaks. The app polls every 2s, so leaked connections
			// pile up across background/relaunch cycles until the per-app limit
			// is reached — after which every service call fails and the app
			// appears frozen when reopened. Cancelling here is the core fix.
			try {
				if (bridge && typeof bridge.cancel === 'function') bridge.cancel();
			} catch (e) {}
			bridge = null;
		}

		bridge.onservicecallback = function (raw) {
			if (done) return;
			var res;
			try {
				res = JSON.parse(raw);
			} catch (e) {
				res = { returnValue: false, errorText: String(raw) };
			}
			if (res && res.returnValue === false) {
				if (opts.onFailure) opts.onFailure(res);
			} else if (opts.onSuccess) {
				opts.onSuccess(res);
			}
			// Non-subscription replies are final — free the connection now.
			if (!subscribed) {
				done = true;
				release();
			}
		};

		try {
			bridge.call(uri, JSON.stringify(params || {}));
		} catch (e) {
			done = true;
			if (opts.onFailure) opts.onFailure({ returnValue: false, errorText: String(e) });
			release();
		}
		return bridge;
	}

	global.lunaCall = call;
})(window);
