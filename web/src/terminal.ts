// web/src/terminal.ts — xterm.js front-end for a tlive wrapped session.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { FrameType, FrameDecoder, encodeData, encodeAttach, encodeResize, parseDims } from './frame.js';

const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const token = new URLSearchParams(location.search).get('token') ?? '';

const termEl = document.getElementById('term') as HTMLElement;
const scaler = document.getElementById('scaler') as HTMLElement;
const viewport = document.getElementById('viewport') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;

const savedFont = parseInt(localStorage.getItem('tlive-font') ?? '', 10);
const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: Number.isFinite(savedFont) && savedFont >= 8 && savedFont <= 28 ? savedFont : 14,
  theme: { background: '#000000' },
});
const fit = new FitAddon();
term.loadAddon(fit);
// URLs become clickable → open in a new tab (the pty screen often has links).
term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
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

const DEBUG = new URLSearchParams(location.search).has('debug');

/** Scale the fixed authoritative grid to fit the viewport; show a hint when not 1:1. */
function applyScale(): void {
  const tw = termEl.offsetWidth, th = termEl.offsetHeight;
  if (tw === 0 || th === 0) return;
  const s = Math.min(viewport.clientWidth / tw, viewport.clientHeight / th);
  scaler.style.transform = `scale(${s})`;
  if (DEBUG) {
    hint.textContent = `grid ${term.cols}×${term.rows} · term ${tw}×${th} · vp ${viewport.clientWidth}×${viewport.clientHeight}`
      + ` · vv ${Math.round(window.visualViewport?.height ?? -1)} · scale ${s.toFixed(3)} · font ${term.options.fontSize}`;
    hint.style.display = 'block';
    return;
  }
  if (s < 0.995) {
    hint.textContent = `${term.cols}×${term.rows} (scaled ${Math.round(s * 100)}%) — type to fit this device`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

// Soft keyboard (iOS/Android): the layout viewport does NOT shrink when the
// keyboard opens — only the visual viewport does. Pin #app to the visual
// viewport so the key bar sits right above the keyboard and the grid re-fits.
const app = document.getElementById('app') as HTMLElement;
const vv = window.visualViewport;
let onVvSettled: (() => void) | null = null;
let lastSent = { cols: 0, rows: 0 };
/** Publish this device's CURRENT ideal grid to the host (throttled to changes).
 *  Doesn't steal authority — it applies when we type. */
function sendIdeal(): void {
  const d = idealDims();
  if (d.cols === lastSent.cols && d.rows === lastSent.rows) return;
  lastSent = d;
  send(encodeResize(d.cols, d.rows));
}
// Pinch-zoom fights the visual-viewport sync (layout thrash → flicker); the
// terminal has its own A± font controls, so page zoom is disabled outright.
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

if (vv) {
  const sync = (): void => {
    // Mid-pinch (some browsers still report scale≠1 transiently): don't thrash layout.
    if (vv.scale && Math.abs(vv.scale - 1) > 0.01) return;
    app.style.height = `${vv.height}px`;
    app.style.transform = `translateY(${vv.offsetTop}px)`; // counter iOS auto-scroll
    window.scrollTo(0, 0);
    applyScale();
    // Keyboard open/close changes the visual viewport WITHOUT a window resize —
    // refresh our ideal size so the next keystroke reflows into the visible area.
    sendIdeal();
    onVvSettled?.(); // mode logic hooks in later (declared below)
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}

// The grid element resizes asynchronously after term.resize()/font changes,
// and the viewport shrinks/grows with the key bar + soft keyboard. Re-fit
// whenever EITHER box actually changes.
const ro = new ResizeObserver(() => applyScale());
ro.observe(termEl);
ro.observe(viewport);

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/term/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}

function connect(): void {
  const dec = new FrameDecoder();
  const sock = new WebSocket(wsUrl());
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => { retry = 0; const d = idealDims(); lastSent = d; sock.send(encodeAttach(d.cols, d.rows)); void loadInfo(); };
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

// ---- header: which session am I looking at ---------------------------------
const theadLabel = document.getElementById('thead-label') as HTMLElement;
const theadMeta = document.getElementById('thead-meta') as HTMLElement;
const theadDot = document.getElementById('thead-dot') as HTMLElement;
const theadPill = document.getElementById('thead-pill') as HTMLElement;
(document.getElementById('back') as HTMLElement).onclick = () => { location.href = `/?token=${encodeURIComponent(token)}`; };
const PILL: Record<string, string> = { active: 'running', 'waiting-approval': 'approve', 'waiting-input': 'reply', idle: 'idle' };
let headPid: number | null = null;
let headStartedAt = 0;
function fmtUptime(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${p(m)}m` : `${m}m ${p(s)}s`;
}
function updateHeadMeta(): void {
  const parts: string[] = [];
  if (headPid != null) parts.push(`PID ${headPid}`);
  if (headStartedAt) parts.push(fmtUptime(Date.now() - headStartedAt));
  theadMeta.textContent = parts.join(' · ');
}
async function loadInfo(): Promise<void> {
  try {
    const res = await fetch(`/api/sessions?token=${encodeURIComponent(token)}`);
    if (!res.ok) return;
    const s = ((await res.json()) as Array<{ id: string; label?: string; pid?: number; status?: string; startedAt?: number }>).find((x) => x.id === id);
    if (!s) return;
    theadLabel.textContent = s.label ?? id;
    document.title = `${s.label ?? 'tlive'} · tlive`;
    theadDot.className = `sdot ${s.status ?? ''}`;
    theadPill.textContent = PILL[s.status ?? ''] ?? '';
    theadPill.className = `pill ${s.status ?? ''}`;
    headPid = s.pid ?? null;
    headStartedAt = s.startedAt ?? 0;
    updateHeadMeta();
  } catch { /* header stays as-is */ }
}
setInterval(updateHeadMeta, 1000);

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
  msg.textContent = '⏹ Session ended';
  const sub = document.createElement('div');
  sub.style.cssText = 'color:#9ca3af;font-size:13px;';
  const back = document.createElement('a');
  back.href = `/?token=${encodeURIComponent(token)}`;
  back.textContent = 'Back to sessions';
  back.style.cssText = 'color:#93c5fd;font-size:14px;';
  overlay.append(msg, sub, back);
  document.body.appendChild(overlay);
  let left = 5;
  const tick = (): void => {
    sub.textContent = `returning to the list in ${left}s`;
    if (left-- <= 0) { location.href = back.href; return; }
    setTimeout(tick, 1000);
  };
  tick();
}
connect();

function send(buf: Uint8Array): void { if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf); }

term.onData((d) => send(encodeData(enc.encode(d))));
window.addEventListener('resize', () => {
  sendIdeal();  // publish our ideal size; server echoes a Size frame when it applies
  applyScale(); // re-fit the current grid to the new viewport immediately
});

// ---- copy on select (tmux/iTerm style) — clipboard API needs HTTPS, so fall
// back to a hidden-textarea execCommand over plain HTTP.
function copyText(t: string): void {
  if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(t).catch(() => fallbackCopy(t)); return; }
  fallbackCopy(t);
}
function fallbackCopy(t: string): void {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch { /* best-effort */ }
  ta.remove();
  if (!shield) term.focus();
}
termEl.addEventListener('mouseup', () => { const s = term.getSelection(); if (s) copyText(s); });

// ---- file upload: paste an image / drop files → upload → path typed into the pty
async function uploadAndType(files: FileList | File[]): Promise<void> {
  const paths: string[] = [];
  for (const f of Array.from(files)) {
    hint.textContent = `⬆ uploading ${f.name}…`;
    hint.style.display = 'block';
    try {
      const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name || 'pasted.png')}&token=${encodeURIComponent(token)}`, {
        method: 'POST',
        body: f,
      });
      if (res.ok) paths.push(((await res.json()) as { path: string }).path);
    } catch { /* ignore this file */ }
  }
  hint.style.display = 'none';
  if (!paths.length) { hint.textContent = 'upload failed'; hint.style.display = 'block'; setTimeout(() => { hint.style.display = 'none'; }, 2000); return; }
  // bracketed paste (no trailing Enter — the user reviews before submitting)
  const payload = paths.join(' ').replace(/\x1b\[20[01]~/g, ''); // no paste-marker escape
  send(encodeData(enc.encode(`\x1b[200~${payload}\x1b[201~`)));
  term.focus();
}
document.addEventListener('paste', (e) => {
  const files = e.clipboardData?.files;
  if (files?.length) { e.preventDefault(); void uploadAndType(files); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (files?.length) void uploadAndType(files);
});

// mobile key bar — keys phones lack (⇧Tab = Claude Code permission-mode cycle)
const BAR: Array<[string, string]> = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['Ctrl-C', '\x03'],
  ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['Ctrl-D', '\x04'], ['Ctrl-Z', '\x1a'], ['Ctrl-R', '\x12'], ['Ctrl-L', '\x0c'],
  ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
];
const bar = document.getElementById('bar') as HTMLElement;
const fab = document.getElementById('fab') as HTMLElement;
/** The FAB is the single input switch.
 *  Touch: view (nothing) → tap ⌨ → input (keyboard + key bar) → tap ⌄ → view.
 *  Desktop: the pty takes keys directly; the FAB just shows/hides the key bar. */
function updateFab(): void {
  if (COARSE) {
    fab.textContent = shield ? '⌨' : '⌄';                   // view: offer typing; input: offer dismiss
    fab.title = shield ? 'Tap to type' : 'Dismiss keyboard';
  } else {
    fab.textContent = app.classList.contains('bar-open') ? '✕' : '⌨';
    fab.title = 'Toggle key bar';
  }
}
function toggleFab(): void {
  if (COARSE) setMode(!!shield);                            // shield present = view → go input
  else { app.classList.toggle('bar-open'); localStorage.setItem('tlive-bar', app.classList.contains('bar-open') ? 'open' : 'closed'); updateFab(); }
}
{ // FAB: draggable, persisted position; tap toggles input (touch) / key bar (desktop)
  // drag to reposition (persisted); a real drag suppresses the toggle click
  try {
    const p = JSON.parse(localStorage.getItem('tlive-fab') ?? 'null') as { r: number; b: number } | null;
    if (p) { fab.style.right = `${p.r}px`; fab.style.bottom = `${p.b}px`; }
  } catch { /* ignore */ }
  fab.style.touchAction = 'none';
  let sx = 0, sy = 0, r0 = 0, b0 = 0, moved = false;
  fab.addEventListener('pointerdown', (e) => {
    sx = e.clientX; sy = e.clientY; moved = false;
    const cs = getComputedStyle(fab);
    r0 = parseFloat(cs.right); b0 = parseFloat(cs.bottom);
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!fab.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 8) moved = true;
    if (!moved) return;
    fab.style.right = `${Math.min(window.innerWidth - 46, Math.max(4, r0 - dx))}px`;
    fab.style.bottom = `${Math.min(window.innerHeight - 46, Math.max(4, b0 - dy))}px`;
  });
  fab.addEventListener('pointerup', () => {
    if (moved) localStorage.setItem('tlive-fab', JSON.stringify({ r: parseFloat(fab.style.right), b: parseFloat(fab.style.bottom) }));
  });
  fab.addEventListener('click', (e) => {
    if (moved) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    toggleFab();
  });
}
// (back-to-list moved to the header bar)
// ---- view/input modes -----------------------------------------------------
// xterm swallows every touch (tap → focus → keyboard; long-press select dies).
// View mode overlays a shield: taps do nothing, keyboard stays down, the key
// bar still works (frames don't need focus). Touch devices default to VIEW.
const COARSE = matchMedia('(pointer: coarse)').matches;
let shield: HTMLElement | null = null;
// Input mode: keyboard up + key bar shown; the pty takes focus.
// View mode: a shield swallows taps (no accidental keyboard), single-finger
// drag scrolls the screen; the key bar is hidden.
function setMode(input: boolean): void {
  if (input) {
    shield?.remove(); shield = null;
    if (COARSE) app.classList.add('bar-open'); // input ⟺ key bar visible
    term.focus();
  } else {
    if (!shield) {
      shield = document.createElement('div');
      shield.id = 'shield';
      shield.style.touchAction = 'none';
      attachTouchScroll(shield);
      app.appendChild(shield);
    }
    if (COARSE) app.classList.remove('bar-open');
    term.blur();
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
  updateFab();
}

// Touch-drag on the shield → synthetic wheel events on the grid. This rides
// xterm's normal wheel path, so a full-screen TUI (claude) receives the same
// scroll sequences a desktop mouse wheel produces: transcript scrolls, the
// prompt stays put. Finger up = content up = wheel down (natural scrolling).
function attachTouchScroll(el: HTMLElement): void {
  const target = (): Element => termEl.querySelector('.xterm-screen') ?? termEl;
  let lastY = 0, acc = 0;
  el.addEventListener('touchstart', (e) => { lastY = e.touches[0].clientY; acc = 0; }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const y = e.touches[0].clientY;
    acc += lastY - y;
    lastY = y;
    const STEP = 18; // px of finger travel per wheel tick
    while (Math.abs(acc) >= STEP) {
      const dir = Math.sign(acc);
      acc -= dir * STEP;
      target().dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 60, bubbles: true, cancelable: true }));
    }
  }, { passive: false });
}
{ // 📎 upload a file/photo → path typed into the pty (mobile has no paste/drop)
  const b = document.createElement('button');
  b.textContent = '📎';
  b.title = 'Send a file/photo to this session';
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.style.display = 'none';
  input.addEventListener('change', () => { if (input.files?.length) { void uploadAndType(input.files); input.value = ''; } });
  b.addEventListener('click', (e) => { e.preventDefault(); input.click(); });
  bar.append(b, input);
}
{ // copy the current screen text (clipboard API needs HTTPS → selectable modal)
  const b = document.createElement('button');
  b.textContent = '⧉';
  b.title = 'Copy screen text';
  const modal = document.getElementById('copym') as HTMLElement;
  const ta = modal.querySelector('textarea') as HTMLTextAreaElement;
  (document.getElementById('copym-close') as HTMLElement).addEventListener('click', () => modal.classList.remove('open'));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    ta.value = lines.join('\n').replace(/\n+$/, '');
    modal.classList.add('open');
  });
  bar.appendChild(b);
}
for (const [label, seq] of BAR) {
  const b = document.createElement('button');
  b.textContent = label;
  // don't re-focus in view mode — that would summon the keyboard back
  b.addEventListener('click', (e) => { e.preventDefault(); send(encodeData(enc.encode(seq))); if (!shield) term.focus(); });
  bar.appendChild(b);
}
// touch devices start in VIEW mode (tap the ⌨ FAB to type); desktops take keys directly
setMode(!COARSE);
// Keyboard dismissed by the system (swipe-down / dismiss key) → return to view
// mode so stray taps don't summon it again, and the key bar collapses with it.
onVvSettled = () => {
  if (COARSE && !shield && vv && vv.height >= window.innerHeight * 0.9) setMode(false);
};

{ // font-size controls (persisted); resizing re-fits and re-requests our ideal grid
  const sp = document.createElement('div');
  sp.className = 'sp';
  bar.appendChild(sp);
  const cellWidth = (): number => {
    const core = (term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number } } } } };
    })._core;
    return core?._renderService?.dimensions?.css?.cell?.width ?? 0;
  };
  const setFont = (delta: number): void => {
    const next = Math.min(28, Math.max(8, term.options.fontSize! + delta));
    if (next === term.options.fontSize) return;
    const prevCell = cellWidth();
    term.options.fontSize = next;
    localStorage.setItem('tlive-font', String(next));
    // Cell metrics update asynchronously with the renderer — measuring too early
    // reads the OLD cell size and computes an unchanged grid (font button "does
    // nothing"). Poll briefly until the metric actually moves.
    let tries = 0;
    const settle = (): void => {
      if (cellWidth() !== prevCell || tries++ > 20) {
        sendIdeal();  // reflow to the new cell grid (applies when we hold authority)
        applyScale();
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  };
  for (const [label, delta] of [['A−', -1], ['A+', 1]] as Array<[string, number]>) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', (e) => { e.preventDefault(); setFont(delta); });
    bar.appendChild(b);
  }
}
