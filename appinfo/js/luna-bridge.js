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
		bridge.onservicecallback = function (raw) {
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
		};

		try {
			bridge.call(uri, JSON.stringify(params || {}));
		} catch (e) {
			if (opts.onFailure) opts.onFailure({ returnValue: false, errorText: String(e) });
		}
		return bridge;
	}

	global.lunaCall = call;
})(window);
