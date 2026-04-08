// Status bar WebSocket client
(function() {
  const statusBar = document.getElementById('status-bar');
  if (!statusBar) return;

  const tokenParam = new URLSearchParams(window.location.search).get('token') || '';

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/status?token=${tokenParam}`);

    ws.onmessage = function(event) {
      try {
        const status = JSON.parse(event.data);
        update(status);
      } catch (e) {
        console.error('Status parse error:', e);
      }
    };

    ws.onclose = function() {
      // Reconnect after 5 seconds
      setTimeout(connect, 5000);
    };

    ws.onerror = function() {
      ws.close();
    };
  }

  function update(status) {
    const sessions = document.getElementById('status-sessions');
    const bridge = document.getElementById('status-bridge');
    const tokens = document.getElementById('status-tokens');
    const cost = document.getElementById('status-cost');
    const version = document.getElementById('status-version');

    if (sessions) {
      const count = status.active_sessions || 0;
      sessions.innerHTML = '<span class="status-dot' + (count > 0 ? ' active' : '') + '">●</span> ' + count + ' session' + (count !== 1 ? 's' : '');
    }

    if (bridge) {
      // Bridge status may not be available yet
      bridge.textContent = 'Bridge: ' + (status.bridge_connected ? 'on' : 'off');
    }

    if (tokens && status.stats) {
      const input = formatNumber(status.stats.input_tokens || 0);
      const output = formatNumber(status.stats.output_tokens || 0);
      tokens.textContent = input + '/' + output + ' tok';
    }

    if (cost && status.stats) {
      cost.textContent = '$' + (status.stats.cost_usd || 0).toFixed(2);
    }

    if (version) {
      version.textContent = 'v' + (status.version || '--');
    }
  }

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  connect();
})();
