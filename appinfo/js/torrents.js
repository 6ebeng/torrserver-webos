/*
 * On-TV torrent client for the TorrServer webOS app.
 *
 * A plain-HTML/JS, D-pad-driven client: list the torrents on the server, add a
 * magnet/hash/link, browse a torrent's files and start playback in an embedded
 * HTML5 <video> player. All TorrServer API calls go through the control
 * service's `torr` proxy (the webview cannot do the Basic Auth itself).
 *
 * Written in ES5 for the old webview runtimes (Chromium 38/53 on webOS 3/4).
 * Depends on the small bridge app.js exposes as window.TS.
 */
(function () {
	'use strict';

	var TS = window.TS;
	if (!TS) return; // app.js not loaded / not on a TV

	var $ = TS.$;
	var svc = TS.svc;
	var msg = TS.msg;
	var escapeHtml = TS.escapeHtml;

	// View state
	var viewOpen = false; // the full-screen torrent list is shown
	var listTimer = null;
	var torrents = [];
	var detailOpen = false;
	var detailHash = null;
	var detailFiles = [];
	var detailTitle = '';
	var addOpen = false;
	var playing = false;

	function mainSections() {
		return Array.prototype.slice.call(document.querySelectorAll('main > section'));
	}

	function showView() {
		viewOpen = true;
		mainSections().forEach(function (s) {
			s.className += (s.className.indexOf('hidden') === -1 ? ' hidden' : '');
		});
		document.querySelector('footer').className = 'hidden';
		$('torrentsview').className = '';
		loadList();
		if (listTimer) clearInterval(listTimer);
		listTimer = setInterval(loadList, 4000);
		$('btnTAdd').focus();
	}

	function hideView() {
		viewOpen = false;
		if (listTimer) {
			clearInterval(listTimer);
			listTimer = null;
		}
		$('torrentsview').className = 'hidden';
		mainSections().forEach(function (s) {
			s.className = s.className.replace(/\s*hidden/g, '');
		});
		document.querySelector('footer').className = '';
		var b = $('btnTorrents');
		if (b) b.focus();
	}

	function humanSize(n) {
		n = +n || 0;
		var u = ['B', 'KB', 'MB', 'GB', 'TB'];
		var i = 0;
		while (n >= 1024 && i < u.length - 1) {
			n = n / 1024;
			i++;
		}
		return (i >= 2 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
	}

	function stateName(stat) {
		// TorrServer torrent state enum: 0=added? map the common ones.
		var m = {
			0: '',
			1: 'in DB',
			2: 'loading',
			3: 'working',
			4: 'closed',
			5: 'paused'
		};
		return m[stat] !== undefined ? m[stat] : '';
	}

	function loadList() {
		if (!viewOpen || detailOpen || addOpen || playing) return;
		svc('torr', { action: 'list' }, function (r) {
			if (!viewOpen) return;
			torrents = (r && r.data) || [];
			if (!torrents.length) torrents = [];
			renderList();
		});
	}

	function renderList() {
		var el = $('tlist');
		if (!torrents.length) {
			el.innerHTML = '<div class="tempty">No torrents yet. Press <b>+ Add</b> to add a magnet link, or manage the server from the Web UI.</div>';
			return;
		}
		var html = '';
		for (var i = 0; i < torrents.length; i++) {
			var t = torrents[i];
			var title = t.title || t.name || t.hash || '(unnamed)';
			var meta = '';
			if (t.torrent_size) meta += '<span class="sz">' + humanSize(t.torrent_size) + '</span>';
			if (t.download_speed) meta += ' &middot; <span class="spd">' + humanSize(t.download_speed) + '/s</span>';
			var st = stateName(t.stat);
			if (st) meta += (meta ? ' &middot; ' : '') + escapeHtml(st);
			html +=
				'<button class="trow" data-hash="' + escapeHtml(t.hash || '') + '">' +
				'<span class="tt">' + escapeHtml(title) + '</span>' +
				(meta ? '<span class="tmeta">' + meta + '</span>' : '') +
				'</button>';
		}
		el.innerHTML = html;
		// Wire row clicks.
		var rows = el.getElementsByTagName('button');
		for (var j = 0; j < rows.length; j++) {
			rows[j].onclick = function () {
				openDetail(this.getAttribute('data-hash'));
			};
		}
	}

	// --- Detail (file browser) ----------------------------------------------
	function openDetail(hash) {
		if (!hash) return;
		detailHash = hash;
		detailOpen = true;
		$('detailmodal').className = 'overlay';
		$('dlist').textContent = 'Loading…';
		$('dTitle').textContent = 'Loading…';
		$('dSub').textContent = '';
		svc('torr', { action: 'get', hash: hash }, function (r) {
			if (!detailOpen) return;
			var t = (r && r.data) || {};
			detailTitle = t.title || t.name || hash;
			$('dTitle').textContent = detailTitle;
			var sub = [];
			if (t.torrent_size) sub.push(humanSize(t.torrent_size));
			if (t.download_speed) sub.push(humanSize(t.download_speed) + '/s');
			$('dSub').textContent = sub.join('  ·  ');
			detailFiles = t.file_stats || [];
			renderFiles();
		});
		$('btnDClose').focus();
	}

	function renderFiles() {
		var el = $('dlist');
		if (!detailFiles.length) {
			el.innerHTML = '<div class="tempty">Files are still loading — the torrent metadata is being fetched. Close and reopen in a moment.</div>';
			return;
		}
		var html = '';
		for (var i = 0; i < detailFiles.length; i++) {
			var f = detailFiles[i];
			var name = f.path || 'file ' + f.id;
			// Only show files that look playable (video/audio) to keep the list
			// short on a TV.
			html +=
				'<button class="vitem" data-id="' + f.id + '" data-name="' + escapeHtml(name) + '">' +
				escapeHtml(shortName(name)) +
				'<span class="fsize">' + humanSize(f.length) + '</span>' +
				'</button>';
		}
		el.innerHTML = html;
		var rows = el.getElementsByTagName('button');
		for (var j = 0; j < rows.length; j++) {
			rows[j].onclick = function () {
				playFile(+this.getAttribute('data-id'), this.getAttribute('data-name'));
			};
		}
		if (rows.length) rows[0].focus();
	}

	function shortName(p) {
		p = String(p || '');
		var parts = p.split('/');
		return parts[parts.length - 1] || p;
	}

	function closeDetail() {
		detailOpen = false;
		detailHash = null;
		$('detailmodal').className = 'overlay hidden';
		if (viewOpen) loadList();
		$('btnTAdd').focus();
	}

	// --- Playback ------------------------------------------------------------
	function playFile(index, name) {
		svc('playUrl', { hash: detailHash, index: index, name: name }, function (r) {
			if (!r || !r.url) {
				msg('Could not build the stream URL.');
				return;
			}
			startPlayer(r.url);
		});
	}

	function startPlayer(url) {
		playing = true;
		var v = $('video');
		$('player').className = 'overlay';
		v.src = url;
		try {
			v.load();
			v.play();
		} catch (e) {}
		v.focus();
	}

	function stopPlayer() {
		playing = false;
		var v = $('video');
		try {
			v.pause();
			v.removeAttribute('src');
			v.load();
		} catch (e) {}
		$('player').className = 'overlay hidden';
	}

	// --- Add torrent ---------------------------------------------------------
	function openAdd() {
		addOpen = true;
		$('addLink').value = '';
		$('addmodal').className = 'overlay';
		$('addLink').focus();
	}

	function closeAdd(refocus) {
		addOpen = false;
		if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
		$('addmodal').className = 'overlay hidden';
		if (refocus !== false) $('btnTAdd').focus();
	}

	function saveAdd() {
		var link = $('addLink').value.replace(/^\s+|\s+$/g, '');
		if (!link) {
			msg('Paste a magnet link, hash, or .torrent URL first.');
			return;
		}
		msg('Adding torrent…');
		svc(
			'torr',
			{ action: 'add', link: link, save_to_db: true },
			function (r) {
				if (r && r.status === 200) {
					msg('Torrent added.');
				} else {
					msg('Could not add that link — check it and try again.');
				}
				loadList();
			},
			function () {
				msg('Could not add that link — check it and try again.');
			}
		);
		closeAdd();
	}

	function removeCurrent() {
		if (!detailHash) return;
		msg('Removing torrent…');
		svc('torr', { action: 'rem', hash: detailHash }, function () {
			msg('Torrent removed.');
			loadList();
		});
		closeDetail();
	}

	// --- Focus helpers -------------------------------------------------------
	function viewButtons() {
		// Focusable controls in the list view: Back, Add, and each torrent row.
		var out = [$('btnTBack'), $('btnTAdd')];
		var rows = $('tlist').getElementsByTagName('button');
		for (var i = 0; i < rows.length; i++) out.push(rows[i]);
		return out.filter(function (b) {
			return b && b.offsetParent !== null;
		});
	}

	function detailButtons() {
		var out = [];
		var rows = $('dlist').getElementsByTagName('button');
		for (var i = 0; i < rows.length; i++) out.push(rows[i]);
		out.push($('btnDRemove'));
		out.push($('btnDClose'));
		return out.filter(function (b) {
			return b && b.offsetParent !== null;
		});
	}

	function addButtons() {
		return [$('addLink'), $('btnAddCancel'), $('btnAddSave')];
	}

	// --- Wiring --------------------------------------------------------------
	$('btnTorrents').onclick = function () {
		showView();
	};
	$('btnTBack').onclick = hideView;
	$('btnTAdd').onclick = openAdd;
	$('btnAddCancel').onclick = function () {
		closeAdd();
	};
	$('btnAddSave').onclick = saveAdd;
	$('btnDClose').onclick = closeDetail;
	$('btnDRemove').onclick = removeCurrent;

	// D-pad navigation. This runs after app.js's handler; we only act when one
	// of our views/modals is open and stop the event so the status-page nav
	// doesn't also fire.
	document.addEventListener(
		'keydown',
		function (e) {
			var k = e.keyCode;
			if (playing) {
				// Back/Return stops playback; everything else goes to the video.
				if (k === 461 || k === 27 || k === 8 || k === 10009) {
					stopPlayer();
					e.preventDefault();
					e.stopPropagation();
				}
				return;
			}
			if (addOpen) {
				if (k === 38 || k === 40) {
					var ab = addButtons();
					var ai = ab.indexOf(document.activeElement);
					if (ai < 0) ai = 0;
					ai = k === 38 ? (ai + ab.length - 1) % ab.length : (ai + 1) % ab.length;
					ab[ai].focus();
					e.preventDefault();
				} else if (k === 461 || k === 27 || k === 8) {
					closeAdd();
					e.preventDefault();
				}
				e.stopPropagation();
				return;
			}
			if (detailOpen) {
				if (k === 38 || k === 40) {
					var db = detailButtons();
					var di = db.indexOf(document.activeElement);
					if (di < 0) di = 0;
					di = k === 38 ? (di + db.length - 1) % db.length : (di + 1) % db.length;
					db[di].focus();
					e.preventDefault();
				} else if (k === 461 || k === 27 || k === 8) {
					closeDetail();
					e.preventDefault();
				}
				e.stopPropagation();
				return;
			}
			if (viewOpen) {
				if (k === 38 || k === 40 || k === 37 || k === 39) {
					var vb = viewButtons();
					var vi = vb.indexOf(document.activeElement);
					if (vi < 0) vi = 0;
					// left/right move along the toolbar, up/down through the list
					if (k === 37 || k === 39) {
						vi = k === 37 ? (vi + vb.length - 1) % vb.length : (vi + 1) % vb.length;
					} else {
						vi = k === 38 ? (vi + vb.length - 1) % vb.length : (vi + 1) % vb.length;
					}
					vb[vi].focus();
					e.preventDefault();
				} else if (k === 461 || k === 27 || k === 8) {
					hideView();
					e.preventDefault();
				}
				e.stopPropagation();
			}
		},
		true // capture, so we run before app.js's bubble-phase handler
	);
})();
