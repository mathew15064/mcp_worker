(() => {
  'use strict';

  const root = document.getElementById('terminal-console-root');
  const screen = document.getElementById('terminal-screen');
  const status = document.getElementById('terminal-connection-status');
  const errorBox = document.getElementById('terminal-console-error');
  const reconnectButton = document.querySelector('[data-terminal-reconnect]');
  const disconnectButton = document.querySelector('[data-terminal-disconnect]');
  if (!root || !screen || !status || !window.Terminal || !window.FitAddon?.FitAddon) return;

  const terminal = new window.Terminal({
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    fontFamily: 'SFMono-Regular, Consolas, Liberation Mono, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: '#03060d',
      foreground: '#dce6f2',
      cursor: '#f8fafc',
      selectionBackground: '#334155'
    }
  });
  const fit = new window.FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(screen);

  let socket = null;
  let connecting = false;

  function setStatus(value, kind = 'off') {
    status.textContent = value;
    status.className = `badge ${kind === 'ok' ? 'badge-ok' : kind === 'danger' ? 'badge-danger' : 'badge-off'}`;
  }

  function showError(message = '') {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function resize() {
    try {
      fit.fit();
      if (terminal.cols > 1 && terminal.rows > 1) send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    } catch (_) {}
  }

  async function connect() {
    if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    connecting = true;
    showError('');
    setStatus('Preparing…');
    reconnectButton?.setAttribute('disabled', 'disabled');
    terminal.focus();

    try {
      const response = await fetch(root.dataset.sessionUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: new URLSearchParams({ _csrf: root.dataset.csrf || '' }).toString()
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ws_url) throw new Error(payload.message || 'Unable to create terminal session.');

      const ws = new WebSocket(payload.ws_url);
      socket = ws;
      ws.addEventListener('open', () => {
        if (socket !== ws) return;
        connecting = false;
        reconnectButton?.removeAttribute('disabled');
        resize();
        terminal.focus();
      });
      ws.addEventListener('message', event => {
        if (socket !== ws) return;
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.type === 'output' && typeof message.data === 'string') {
          terminal.write(message.data);
          return;
        }
        if (message.type === 'state') {
          const labels = {
            CONNECTING: 'Connecting…',
            ATTACHING: 'Attaching shell…',
            CONNECTED: 'Connected',
            CLOSED: 'Disconnected'
          };
          setStatus(labels[message.state] || message.state || 'Connecting…', message.state === 'CONNECTED' ? 'ok' : 'off');
          if (message.state === 'CONNECTED') terminal.focus();
          return;
        }
        if (message.type === 'error') {
          setStatus('Connection failed', 'danger');
          showError(`${message.message || 'Terminal connection failed.'}${message.code ? ` (${message.code})` : ''}`);
        }
      });
      ws.addEventListener('close', () => {
        if (socket !== ws) return;
        socket = null;
        connecting = false;
        reconnectButton?.removeAttribute('disabled');
        if (!errorBox?.textContent) setStatus('Disconnected');
      });
      ws.addEventListener('error', () => {
        if (socket !== ws) return;
        setStatus('Connection failed', 'danger');
        showError('WebSocket connection failed. Use Test Shell on the profile to verify the Worker and direct shell.');
      });
    } catch (error) {
      connecting = false;
      reconnectButton?.removeAttribute('disabled');
      setStatus('Connection failed', 'danger');
      showError(error.message || 'Unable to open terminal session.');
    }
  }

  function disconnect() {
    const current = socket;
    socket = null;
    connecting = false;
    if (current?.readyState === WebSocket.OPEN) {
      try { current.send(JSON.stringify({ type: 'close' })); } catch (_) {}
    }
    try { current?.close(); } catch (_) {}
    reconnectButton?.removeAttribute('disabled');
    setStatus('Disconnected');
  }

  terminal.onData(data => send({ type: 'input', data }));
  terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
  reconnectButton?.addEventListener('click', () => {
    disconnect();
    terminal.write('\r\n\x1b[90m[reconnecting]\x1b[0m\r\n');
    setTimeout(connect, 50);
  });
  disconnectButton?.addEventListener('click', disconnect);

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(screen);
  window.addEventListener('beforeunload', disconnect, { once: true });
  requestAnimationFrame(() => {
    resize();
    connect();
  });
})();
