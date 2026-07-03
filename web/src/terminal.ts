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

/** What THIS device's viewport could hold at 1:1, in grid cells.
 *  NOTE: fit.proposeDimensions() measures #term (content-sized to the grid),
 *  so it would just echo the current grid — a fixed point. We divide the real
 *  viewport by xterm's measured cell size instead, so typing reflows the pty
 *  to this device. Cell metrics come from the same render-service field FitAddon reads. */
function idealDims(): { cols: number; rows: number } {
  const core = (term as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
  })._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (cell && cell.width > 0 && cell.height > 0) {
    return {
      cols: Math.max(1, Math.floor(viewport.clientWidth / cell.width)),
      rows: Math.max(1, Math.floor(viewport.clientHeight / cell.height)),
    };
  }
  // Before the first render the metrics aren't ready; fall back to the fitted proposal.
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
    // Session may be gone (process exited / reaped) — check before blindly reconnecting.
    void checkAlive().then((alive) => {
      if (!alive) { showEnded(); return; }
      setTimeout(connect, 500 * retry); // linear backoff, capped at ~3s (retry maxes at 6)
    });
  };
  sock.onerror = () => sock.close();
}

/** Is this session still listed (with a live pty)? Network errors (daemon
 *  restarting) count as alive — keep retrying rather than declaring it dead. */
async function checkAlive(): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions?token=${encodeURIComponent(token)}`);
    if (!res.ok) return true;
    const list = (await res.json()) as Array<{ id: string; sockPath?: string }>;
    return list.some((s) => s.id === id && !!s.sockPath);
  } catch {
    return true;
  }
}

let ended = false;
function showEnded(): void {
  if (ended) return;
  ended = true;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10;display:flex;flex-direction:column;gap:14px;'
    + 'align-items:center;justify-content:center;background:rgba(0,0,0,.82);color:#e6e6e6;'
    + 'font:15px ui-monospace,Menlo,monospace;text-align:center;padding:24px;';
  const msg = document.createElement('div');
  msg.textContent = '⏹ 会话已结束';
  const sub = document.createElement('div');
  sub.style.cssText = 'color:#9ca3af;font-size:13px;';
  const back = document.createElement('a');
  back.href = `/?token=${encodeURIComponent(token)}`;
  back.textContent = '返回会话列表';
  back.style.cssText = 'color:#93c5fd;font-size:14px;';
  overlay.append(msg, sub, back);
  document.body.appendChild(overlay);
  let left = 5;
  const tick = (): void => {
    sub.textContent = `${left} 秒后自动返回会话列表`;
    if (left-- <= 0) { location.href = back.href; return; }
    setTimeout(tick, 1000);
  };
  tick();
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
{ // back to the session list
  const b = document.createElement('button');
  b.textContent = '☰ 列表';
  b.addEventListener('click', () => { location.href = `/?token=${encodeURIComponent(token)}`; });
  bar.appendChild(b);
}
for (const [label, seq] of BAR) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (e) => { e.preventDefault(); send(encodeData(enc.encode(seq))); term.focus(); });
  bar.appendChild(b);
}
