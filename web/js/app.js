(function() {
    'use strict';

    var sessionsEl = document.getElementById('sessions');
    var emptyMsg = document.getElementById('empty-msg');
    var countBadge = document.getElementById('session-count');
    var statusBadge = document.getElementById('status');
    var tokenParam = new URLSearchParams(window.location.search).get('token') ||
        (document.cookie.match(/(?:^|;\s*)tl_token=([^;]*)/) || [])[1] || '';

    if (!sessionsEl) return;

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Hidden container for offscreen xterm rendering
    var offscreen = document.createElement('div');
    offscreen.style.cssText = 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;';
    document.body.appendChild(offscreen);

    function populatePreview(previewEl, rawBase64, rows, cols) {
        if (!rawBase64) return;
        var ptyRows = rows || 24;
        var ptyCols = cols || 80;

        var term = new Terminal({
            rows: ptyRows,
            cols: ptyCols,
            scrollback: 0,
            cursorBlink: false,
            disableStdin: true,
        });

        var container = document.createElement('div');
        offscreen.appendChild(container);
        term.open(container);

        try {
            var binary = atob(rawBase64);
            var bytes = new Uint8Array(binary.length);
            for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
            term.write(bytes, function() {
                var buf = term.buffer.active;
                var lines = [];
                var lastNonEmpty = -1;
                for (var y = buf.length - 1; y >= 0; y--) {
                    var line = buf.getLine(y);
                    if (line && line.translateToString(true).trim() !== '') {
                        lastNonEmpty = y;
                        break;
                    }
                }
                if (lastNonEmpty >= 0) {
                    var startRow = Math.max(0, lastNonEmpty - 7);
                    for (var y = startRow; y <= lastNonEmpty; y++) {
                        var line = buf.getLine(y);
                        if (line) lines.push(line.translateToString(false).replace(/\s+$/, ''));
                    }
                }
                while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

                term.dispose();
                offscreen.removeChild(container);

                if (lines.length > 0) {
                    previewEl.textContent = lines.join('\n');
                    previewEl.style.display = '';
                }
            });
        } catch(e) {
            term.dispose();
            offscreen.removeChild(container);
        }
    }

    function showSkeletons() {
        var html = '';
        for (var i = 0; i < 3; i++) {
            html += '<div class="skeleton-card">' +
                '<div class="skeleton-line short"></div>' +
                '<div class="skeleton-line medium"></div>' +
                '<div class="skeleton-line long"></div>' +
                '</div>';
        }
        sessionsEl.innerHTML = html;
    }

    var prevSessionHash = '';

    function loadSessions() {
        fetch('/api/sessions', { headers: { 'Authorization': 'Bearer ' + tokenParam } })
            .then(function(resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.json();
            })
            .then(function(sessions) {
                statusBadge.className = 'status-badge online';
                statusBadge.querySelector('.status-text').textContent = 'Connected';

                if (!sessions || sessions.length === 0) {
                    sessionsEl.innerHTML = '';
                    emptyMsg.style.display = 'block';
                    countBadge.textContent = '0';
                    prevSessionHash = '';
                    return;
                }

                var hash = sessions.map(function(s) {
                    return s.id + ':' + s.status + ':' + s.duration + ':' + (s.preview_raw || '').length;
                }).join('|');
                if (hash === prevSessionHash) return;
                prevSessionHash = hash;

                emptyMsg.style.display = 'none';
                countBadge.textContent = sessions.length;

                sessionsEl.innerHTML = sessions.map(function(s, i) {
                    var isRunning = s.status === 'running';
                    var termUrl = '/terminal.html?id=' + s.id + (tokenParam ? '&token=' + encodeURIComponent(tokenParam) : '');
                    var statusClass = isRunning ? 'running' : 'exited';

                    var cwdTag = s.cwd ? '<span class="meta-cwd">' + escapeHtml(s.cwd) + '</span>' : '';

                    return '<div class="session-card ' + statusClass + '" onclick="location.href=\'' + termUrl + '\'">' +
                        '<div class="card-header">' +
                            '<span class="name">' + escapeHtml(s.command) + '</span>' +
                            '<span class="card-status ' + statusClass + '">' + escapeHtml(s.status) + '</span>' +
                        '</div>' +
                        '<div class="meta">' + cwdTag + 'PID ' + s.pid + ' &middot; ' + escapeHtml(s.duration) + '</div>' +
                        '<pre class="preview" data-idx="' + i + '" style="display:none"></pre>' +
                        '</div>';
                }).join('');

                // Async populate previews
                sessions.forEach(function(s, i) {
                    var el = sessionsEl.querySelector('[data-idx="' + i + '"]');
                    if (el && s.preview_raw) {
                        populatePreview(el, s.preview_raw, s.rows, s.cols);
                    }
                });
            })
            .catch(function(e) {
                console.error('Failed to load sessions:', e);
                statusBadge.className = 'status-badge offline';
                statusBadge.querySelector('.status-text').textContent = 'Disconnected';
            });
    }

    showSkeletons();
    loadSessions();
    setInterval(loadSessions, 3000);
})();
