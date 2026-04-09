(function() {
    'use strict';

    var params = new URLSearchParams(window.location.search);
    var tokenParam = params.get('token') || '';
    var sessionParam = params.get('session') || '';

    var term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Cascadia Mono', 'Cascadia Code', 'MesloLGS NF', 'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
        theme: {
            background: '#0d1117',
            foreground: '#e6edf3',
            cursor: '#4ecca3',
            selectionBackground: '#264f78',
        },
        allowProposedApi: true,
    });

    var fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));

    var statusBadge = document.getElementById('session-status');
    var statusText = document.getElementById('status-text');
    var overlay = document.getElementById('disconnect-overlay');
    var sessionName = document.getElementById('session-name');
    if (sessionName) sessionName.textContent = sessionParam ? 'Session #' + sessionParam.slice(0, 6) : 'TLive v1.0';

    // Show back link when in multi-session mode (session param present)
    var backLink = document.getElementById('back-link');
    if (backLink) {
        if (sessionParam) {
            backLink.href = '/' + (tokenParam ? '?token=' + encodeURIComponent(tokenParam) : '');
        } else {
            backLink.style.display = 'none';
        }
    }

    var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProtocol + '//' + location.host + '/?token=' + encodeURIComponent(tokenParam) +
        (sessionParam ? '&session=' + encodeURIComponent(sessionParam) : '');
    var ws = null;
    var reconnectTimer = null;
    var processExited = false;

    function sendResize() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }));
        }
    }

    function setConnected(connected) {
        if (connected) {
            statusBadge.className = 'status-badge online';
            statusText.textContent = 'Connected';
            overlay.style.display = 'none';
        } else {
            statusBadge.className = 'status-badge offline';
            statusText.textContent = 'Reconnecting...';
            overlay.style.display = 'flex';
        }
    }

    function connect() {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = function() {
            setConnected(true);
            fitAddon.fit();
            sendResize();
        };

        ws.onmessage = function(event) {
            if (typeof event.data === 'string') {
                try {
                    var ctrl = JSON.parse(event.data);
                    if (ctrl.type === 'exit') {
                        processExited = true;
                        showExitOverlay(ctrl.code);
                        return;
                    }
                } catch(e) { /* not JSON */ }
                term.write(event.data);
                return;
            }
            term.write(new TextDecoder().decode(event.data));
        };

        ws.onclose = function() {
            if (processExited) return;
            setConnected(false);
            reconnectTimer = setTimeout(connect, 2000);
        };

        ws.onerror = function() { ws.close(); };
    }

    term.onData(function(data) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(function() { sendResize(); });
    window.addEventListener('resize', function() { fitAddon.fit(); });

    function showExitOverlay(code) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        statusBadge.className = 'status-badge offline';
        statusText.textContent = 'Exited';
        var content = overlay.querySelector('.disconnect-content');
        content.innerHTML =
            '<div class="disconnect-icon">&#9209;</div>' +
            '<p>Process exited (code ' + code + ')</p>';
        overlay.style.display = 'flex';
    }

    connect();
})();
