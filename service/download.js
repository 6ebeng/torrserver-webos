/*
 * Streaming HTTPS/HTTP downloader with redirect support.
 * Used as a last-resort fallback by torrserver-run.sh when neither curl nor
 * wget is available on the TV. Uses only Node core modules.
 *
 *   node download.js <url> <destination>
 */
/* eslint-disable */
var https = require('https');
var http = require('http');
var fs = require('fs');
var urlmod = require('url');

var src = process.argv[2];
var dest = process.argv[3];

if (!src || !dest) {
	process.stderr.write('usage: download.js <url> <dest>\n');
	process.exit(2);
}

function get(u, redirects, cb) {
	if (redirects > 10) {
		cb(new Error('too many redirects'));
		return;
	}

	var parsed = urlmod.parse(u);
	var mod = parsed.protocol === 'http:' ? http : https;
	var opts = {
		host: parsed.hostname,
		port: parsed.port,
		path: parsed.path,
		headers: {
			'User-Agent': 'torrserver-webos',
			Accept: '*/*',
		},
	};

	mod
		.get(opts, function (res) {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				get(urlmod.resolve(u, res.headers.location), redirects + 1, cb);
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				cb(new Error('HTTP ' + res.statusCode));
				return;
			}
			var out = fs.createWriteStream(dest);
			res.pipe(out);
			out.on('finish', function () {
				out.close(function () {
					cb(null);
				});
			});
			out.on('error', cb);
		})
		.on('error', cb);
}

get(src, 0, function (err) {
	if (err) {
		process.stderr.write(String(err) + '\n');
		process.exit(1);
	}
	process.exit(0);
});
