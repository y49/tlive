// web/src/terminal.ts — xterm.js front-end for a tlive wrapped session.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { FrameType, FrameDecoder, encodeData, encodeAttach, encodeResize } from './frame.js';

const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const token = new URLSearchParams(location.search).get('token') ?? '';

const term = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 14, theme: { background: '#000000' } });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term') as HTMLElement);
fit.fit();

const enc = new TextEncoder();
let ws: WebSocket | null = null;
const dec = new FrameDecoder();
let retry = 0;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/term/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}

function connect(): void {
  const sock = new WebSocket(wsUrl());
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => { retry = 0; fit.fit(); sock.send(encodeAttach(term.cols, term.rows)); };
  sock.onmessage = (ev) => {
    for (const f of dec.push(new Uint8Array(ev.data as ArrayBuffer))) {
      if (f.type === FrameType.Data) term.write(f.payload);
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * retry); // reconnect with backoff
  };
  sock.onerror = () => sock.close();
}
connect();

function send(buf: Uint8Array): void { if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf); }

term.onData((d) => send(encodeData(enc.encode(d))));
window.addEventListener('resize', () => { fit.fit(); send(encodeResize(term.cols, term.rows)); });

// mobile key bar — keys phones lack
const BAR: Array<[string, string]> = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl-C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
];
const bar = document.getElementById('bar') as HTMLElement;
for (const [label, seq] of BAR) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (e) => { e.preventDefault(); send(encodeData(enc.encode(seq))); term.focus(); });
  bar.appendChild(b);
}
