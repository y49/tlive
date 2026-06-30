// web/src/terminal.ts — xterm.js front-end for a tlive wrapped session.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { FrameType, FrameDecoder, encodeData, encodeAttach, encodeResize, parseDims } from './frame.js';

const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const token = new URLSearchParams(location.search).get('token') ?? '';

const termEl = document.getElementById('term') as HTMLElement;
const scaler = document.getElementById('scaler') as HTMLElement;
const viewport = document.getElementById('viewport') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;

const term = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 14, theme: { background: '#000000' } });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(termEl);

const enc = new TextEncoder();
let ws: WebSocket | null = null;
let retry = 0;

/** What this viewport could hold at 1:1 (propose, don't actually resize the grid). */
function idealDims(): { cols: number; rows: number } {
  const d = fit.proposeDimensions();
  return { cols: Math.max(1, d?.cols ?? 80), rows: Math.max(1, d?.rows ?? 24) };
}

/** Scale the fixed authoritative grid to fit the viewport; show a hint when not 1:1. */
function applyScale(): void {
  const tw = termEl.offsetWidth, th = termEl.offsetHeight;
  if (tw === 0 || th === 0) return;
  const s = Math.min(viewport.clientWidth / tw, viewport.clientHeight / th);
  scaler.style.transform = `scale(${s})`;
  if (s < 0.995) {
    hint.textContent = `viewing ${term.cols}×${term.rows} (scaled ${Math.round(s * 100)}%) — type to fit this device`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/term/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}

function connect(): void {
  const dec = new FrameDecoder();
  const sock = new WebSocket(wsUrl());
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => { retry = 0; const d = idealDims(); sock.send(encodeAttach(d.cols, d.rows)); };
  sock.onmessage = (ev) => {
    for (const f of dec.push(new Uint8Array(ev.data as ArrayBuffer))) {
      if (f.type === FrameType.Data) {
        term.write(f.payload);
      } else if (f.type === FrameType.Size) {
        const { cols, rows } = parseDims(f.payload);
        term.resize(cols, rows);
        requestAnimationFrame(applyScale);
      }
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * retry); // linear backoff, capped at ~3s (retry maxes at 6)
  };
  sock.onerror = () => sock.close();
}
connect();

function send(buf: Uint8Array): void { if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf); }

term.onData((d) => send(encodeData(enc.encode(d))));
window.addEventListener('resize', () => {
  const d = idealDims();
  send(encodeResize(d.cols, d.rows)); // request authority at our ideal size; server echoes a Size frame
  applyScale();                       // re-fit the current grid to the new viewport immediately
});

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
