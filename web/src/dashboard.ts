// web/src/dashboard.ts — tlive session dashboard (design: c73ecba6).
// Live monitor + interaction over /ws/events. One card per session with a
// mac-chrome live terminal preview, status pill, PID/path/uptime, and
// mute / copy-link / upload / Terminal actions. Approval + reply stay inline.

import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { FrameType, FrameDecoder, encodeAttach, parseDims } from './frame.js';

const token = new URLSearchParams(location.search).get('token') ?? '';

type Status = 'active' | 'waiting-approval' | 'waiting-input' | 'idle';
interface Pending { requestId: string; title: string; body: string; toolName?: string }
interface SessionView {
  id: string; label: string; cwd: string;
  kind: 'wrapped' | 'hook'; status: Status;
  lastActivityAt: number; startedAt?: number; lastMessage?: string; lastPrompt?: string;
  pending?: Pending; continueId?: string; muted: boolean; sockPath?: string; pid?: number;
}
type Frame =
  | { type: 'session-upsert'; session: SessionView }
  | { type: 'session-remove'; id: string };
type Action =
  | { type: 'approve'; requestId: string; approved: boolean; alwaysAllowTool?: string }
  | { type: 'reply'; requestId: string; text: string }
  | { type: 'mute'; id: string; muted: boolean }
  | { type: 'inject'; id: string; text: string };

const sessions = new Map<string, SessionView>();
const grid = document.getElementById('grid') as HTMLElement;
const empty = document.getElementById('empty') as HTMLElement;
const conn = document.getElementById('conn') as HTMLElement;
const count = document.getElementById('count') as HTMLElement;

let ws: WebSocket | null = null;
let retry = 0;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/events?token=${encodeURIComponent(token)}`;
}
function send(action: Action): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(action));
}

function connect(): void {
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.onopen = () => { retry = 0; conn.textContent = 'live'; conn.className = 'up'; void reconcile(); };
  sock.onmessage = (ev) => {
    let f: Frame;
    try { f = JSON.parse(String(ev.data)); } catch { return; }
    if (f.type === 'session-upsert') sessions.set(f.session.id, f.session);
    else if (f.type === 'session-remove') sessions.delete(f.id);
    render();
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    conn.textContent = 'reconnecting'; conn.className = '';
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * retry);
  };
  sock.onerror = () => sock.close();
}

// Full reconcile from the REST list (heals ghost cards after a missed remove).
async function reconcile(): Promise<void> {
  try {
    const res = await fetch(`/api/sessions?token=${encodeURIComponent(token)}`);
    if (!res.ok) return;
    const list = (await res.json()) as SessionView[];
    const ids = new Set(list.map((s) => s.id));
    for (const s of list) sessions.set(s.id, s);
    for (const id of [...sessions.keys()]) if (!ids.has(id)) sessions.delete(id);
    render();
  } catch { /* ws will populate */ }
}

// ---- helpers ----------------------------------------------------------------
function esc(t: string): string { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function escAttr(t: string): string { return esc(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function fmtUptime(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${p(m)}m` : `${m}m ${p(s)}s`;
}

function copyLink(url: string): void {
  if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(url).catch(() => fallbackCopy(url)); return; }
  fallbackCopy(url);
}
function fallbackCopy(t: string): void {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch { /* best-effort */ }
  ta.remove();
}

const replyDrafts = new Map<string, string>();

/** markdown-ish approval body (fences + diff lines) with colors */
function renderApprovalBody(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of body.split('\n')) {
    const m = raw.match(/^```(\w*)/);
    if (m) { fence = fence === null ? (m[1] || 'txt') : null; continue; }
    const line = esc(raw);
    if (fence === 'diff') {
      if (raw.startsWith('+')) { out.push(`<span class="d-add">${line}</span>`); continue; }
      if (raw.startsWith('-')) { out.push(`<span class="d-del">${line}</span>`); continue; }
      if (raw.startsWith('@@')) { out.push(`<span class="d-hunk">${line}</span>`); continue; }
    } else if (fence === 'bash') { out.push(`<span class="d-cmd">${line}</span>`); continue; }
    if (raw.includes('⚠️')) { out.push(`<span class="d-del">${line.replace(/\*\*/g, '')}</span>`); continue; }
    out.push(line.replace(/`([^`]+)`/g, '<span class="k">$1</span>'));
  }
  return out.join('\n');
}

// ---- status palette (design c73ecba6) --------------------------------------
interface Palette { key: string; label: string; accent: string; fade: string; glow: string; glowbg: string; pillText: string; pillBg: string; pillBorder: string; run: boolean }
const RUNNING: Palette = { key: 'running', label: 'running', accent: '#35d07f', fade: 'rgba(53,208,127,.15)', glow: '#35d07f', glowbg: 'rgba(53,208,127,.10)', pillText: '#8ee6b4', pillBg: 'rgba(53,208,127,.10)', pillBorder: 'rgba(53,208,127,.30)', run: true };
const WAITING = (label: string): Palette => ({ key: 'waiting', label, accent: '#e6c169', fade: 'rgba(230,193,105,.12)', glow: 'rgba(230,193,105,.7)', glowbg: 'rgba(230,193,105,.08)', pillText: '#f0d492', pillBg: 'rgba(230,193,105,.10)', pillBorder: 'rgba(230,193,105,.32)', run: false });
const IDLE: Palette = { key: 'idle', label: 'idle', accent: '#5b9bff', fade: 'rgba(91,155,255,.12)', glow: 'rgba(91,155,255,.6)', glowbg: 'rgba(91,155,255,.07)', pillText: '#a9c7ff', pillBg: 'rgba(91,155,255,.10)', pillBorder: 'rgba(91,155,255,.30)', run: false };
function palette(s: SessionView): Palette {
  switch (s.status) {
    case 'active': return RUNNING;
    case 'waiting-approval': return WAITING('approve');
    case 'waiting-input': return WAITING('reply');
    default: return IDLE;
  }
}

// ---- live terminal previews -------------------------------------------------
interface Preview { el: HTMLElement; term: Terminal; ws: WebSocket | null; dead: boolean; screen: HTMLElement; scaler: HTMLElement }
const previews = new Map<string, Preview>();

function fitPreview(pv: Preview): void {
  const t = pv.scaler.firstElementChild as HTMLElement;
  if (!t || t.offsetWidth === 0) return;
  const s = pv.screen.clientWidth / t.offsetWidth;
  const scaledH = Math.ceil(t.offsetHeight * s);
  const h = Math.min(220, scaledH);          // width-fit; clip, pin the bottom
  pv.scaler.style.transform = `scale(${s})`;
  pv.screen.style.height = `${h}px`;
  pv.scaler.style.top = `${Math.min(0, h - scaledH)}px`;
}

function createPreview(id: string, name: string): Preview {
  const el = document.createElement('div');
  el.className = 'win';
  el.innerHTML =
    '<div class="chrome">'
    + '<span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span>'
    + `<span class="title">${esc(name)} — zsh</span></div>`
    + '<div class="screen"><div class="pv-scaler"></div></div>';
  const screen = el.querySelector('.screen') as HTMLElement;
  const scaler = el.querySelector('.pv-scaler') as HTMLElement;
  const term = new Terminal({ disableStdin: true, fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace', theme: { background: '#06080c' }, scrollback: 0 });
  term.open(scaler);
  const pv: Preview = { el, term, ws: null, dead: false, screen, scaler };
  el.addEventListener('click', () => window.open(`/s/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, '_blank'));

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let r = 0;
  const connectPv = (): void => {
    if (pv.dead) return;
    const dec = new FrameDecoder();
    const sock = new WebSocket(`${proto}://${location.host}/ws/term/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`);
    sock.binaryType = 'arraybuffer';
    pv.ws = sock;
    sock.onopen = () => { r = 0; sock.send(encodeAttach(0, 0)); };
    sock.onmessage = (ev) => {
      for (const f of dec.push(new Uint8Array(ev.data as ArrayBuffer))) {
        if (f.type === FrameType.Data) term.write(f.payload);
        else if (f.type === FrameType.Size) { const { cols, rows } = parseDims(f.payload); term.resize(cols, rows); requestAnimationFrame(() => fitPreview(pv)); }
      }
    };
    sock.onclose = () => { if (!pv.dead) { r = Math.min(r + 1, 6); setTimeout(connectPv, 1000 * r); } };
    sock.onerror = () => sock.close();
  };
  connectPv();
  previews.set(id, pv);
  return pv;
}
function disposePreview(id: string): void {
  const pv = previews.get(id);
  if (!pv) return;
  pv.dead = true;
  try { pv.ws?.close(); } catch { /* ignore */ }
  pv.term.dispose(); pv.el.remove(); previews.delete(id);
}

const ICON_MUTE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const ICON_BELL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
const ICON_LINK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
const ICON_CLIP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

function iconBtn(cls: string, svg: string, title: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `icon-btn${cls ? ' ' + cls : ''}`;
  b.innerHTML = svg; b.title = title;
  b.onclick = (e) => { e.stopPropagation(); on(); };
  return b;
}

function card(s: SessionView): HTMLElement {
  const p = palette(s);
  const el = document.createElement('div');
  el.className = 'card';
  el.style.cssText = `--s-accent:${p.accent};--s-fade:${p.fade};--s-glow:${p.glow};--s-glowbg:${p.glowbg};--s-pilltext:${p.pillText};--s-pillbg:${p.pillBg};--s-pillborder:${p.pillBorder}`;
  el.innerHTML = '<div class="glow"></div><div class="rail"></div>';

  const body = document.createElement('div'); body.className = 'body';

  // head: name + pill / pid + path / uptime
  const head = document.createElement('div'); head.className = 'head';
  const uptime = s.startedAt ? `<div class="uptime" data-started="${s.startedAt}">uptime ${fmtUptime(Date.now() - s.startedAt)}</div>` : '';
  head.innerHTML =
    `<div class="row"><div class="name-wrap"><div class="name-line">`
    + `<span class="sdot${p.run ? ' run' : ''}"></span><span class="name" title="${escAttr(s.label)}">${esc(s.label)}</span></div></div>`
    + `<div class="right"><span class="pill">${p.label}</span>${uptime}</div></div>`
    + `<div class="meta">${s.pid != null ? `<span class="pid">PID ${Number(s.pid)}</span>` : ''}<span class="path" title="${escAttr(s.cwd)}">${esc(s.cwd)}</span></div>`;
  body.appendChild(head);

  // preview (wrapped) OR a message block
  if (s.kind === 'wrapped' && s.sockPath) {
    const pv = previews.get(s.id) ?? createPreview(s.id, s.label);
    body.appendChild(pv.el);
    requestAnimationFrame(() => fitPreview(pv));
  }

  // foot: approval / reply / last-msg + actions
  const foot = document.createElement('div'); foot.className = 'foot';
  foot.style.cssText = 'display:flex;flex-direction:column;gap:13px';

  if (s.pending) {
    const m = document.createElement('div'); m.className = 'msg approval';
    m.innerHTML = `<span class="k">${esc(s.pending.title)}</span>\n${renderApprovalBody(s.pending.body)}`;
    foot.appendChild(m);
  } else if (!(s.kind === 'wrapped' && s.sockPath) && (s.lastMessage || s.lastPrompt)) {
    const m = document.createElement('div'); m.className = 'msg';
    m.innerHTML = s.lastMessage ? `<span class="k">last:</span> ${esc(s.lastMessage)}` : `<span class="k">prompt:</span> ${esc(s.lastPrompt!)}`;
    foot.appendChild(m);
  }

  const actions = document.createElement('div'); actions.className = 'actions';

  if (s.pending) {
    const rid = s.pending.requestId, tool = s.pending.toolName;
    const ok = document.createElement('button'); ok.className = 'btn ok'; ok.textContent = '✅ Allow';
    ok.onclick = () => send({ type: 'approve', requestId: rid, approved: true });
    const no = document.createElement('button'); no.className = 'btn no'; no.textContent = '❌ Deny';
    no.onclick = () => send({ type: 'approve', requestId: rid, approved: false });
    actions.append(ok, no);
    if (tool) {
      const al = document.createElement('button'); al.className = 'btn ok'; al.textContent = `Always ${tool}`;
      al.title = 'Allow now AND auto-allow this tool until the daemon restarts';
      al.onclick = () => send({ type: 'approve', requestId: rid, approved: true, alwaysAllowTool: tool });
      actions.append(al);
    }
  }

  actions.appendChild(iconBtn(s.muted ? 'on' : '', s.muted ? ICON_MUTE : ICON_BELL,
    s.muted ? 'Muted — resume IM cards/notifications' : 'Mute IM cards/notifications for this session',
    () => send({ type: 'mute', id: s.id, muted: !s.muted })));

  if (s.sockPath) {
    actions.appendChild(iconBtn('', ICON_LINK, 'Copy session link',
      () => copyLink(`${location.origin}/s/${encodeURIComponent(s.id)}?token=${encodeURIComponent(token)}`)));
    actions.appendChild(iconBtn('', ICON_CLIP, 'Send a file/photo to this session', () => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
      input.onchange = async () => {
        const paths: string[] = [];
        for (const f of Array.from(input.files ?? [])) {
          try { const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}&token=${encodeURIComponent(token)}`, { method: 'POST', body: f }); if (res.ok) paths.push(((await res.json()) as { path: string }).path); } catch { /* skip */ }
        }
        if (paths.length) send({ type: 'inject', id: s.id, text: paths.join(' ') });
      };
      input.click();
    }));
  }

  const spring = document.createElement('div'); spring.className = 'spring'; actions.appendChild(spring);

  if (s.sockPath) {
    const link = document.createElement('a'); link.className = 'term-btn';
    link.href = `/s/${encodeURIComponent(s.id)}?token=${encodeURIComponent(token)}`;
    link.target = '_blank'; link.rel = 'noopener';
    link.innerHTML = '<span class="g">&gt;_</span><span>Terminal</span>';
    actions.appendChild(link);
  }
  foot.appendChild(actions);

  if (s.status === 'waiting-input' && s.continueId) {
    const cid = s.continueId;
    const row = document.createElement('div'); row.className = 'reply';
    const input = document.createElement('input');
    input.className = 'reply-input'; input.dataset.sid = s.id; input.placeholder = 'reply to continue…';
    input.value = replyDrafts.get(s.id) ?? '';
    input.oninput = () => { replyDrafts.set(s.id, input.value); };
    const btn = document.createElement('button'); btn.className = 'btn ok'; btn.textContent = 'Send';
    const fire = (): void => { const t = input.value.trim(); if (t) { send({ type: 'reply', requestId: cid, text: t }); replyDrafts.delete(s.id); input.value = ''; } };
    btn.onclick = fire; input.onkeydown = (e) => { if (e.key === 'Enter') fire(); };
    row.append(input, btn); foot.appendChild(row);
  }

  body.appendChild(foot);
  el.appendChild(body);
  return el;
}

// needs-attention first, then most-recent
const RANK: Record<Status, number> = { 'waiting-approval': 0, 'waiting-input': 1, 'active': 2, 'idle': 3 };

function render(): void {
  const list = [...sessions.values()].sort((a, b) => RANK[a.status] - RANK[b.status] || b.lastActivityAt - a.lastActivityAt);
  empty.style.display = list.length ? 'none' : 'block';
  count.textContent = String(list.length);
  const active = document.activeElement as HTMLInputElement | null;
  const focusSid = active?.classList.contains('reply-input') ? active.dataset.sid : undefined;
  const caret = active?.selectionStart ?? null;
  grid.replaceChildren(...list.map(card));
  if (focusSid) {
    const next = grid.querySelector(`.reply-input[data-sid="${CSS.escape(focusSid)}"]`) as HTMLInputElement | null;
    if (next) { next.focus(); if (caret != null) try { next.setSelectionRange(caret, caret); } catch { /* ignore */ } }
  }
  for (const id of [...previews.keys()]) {
    const s = sessions.get(id);
    if (!s || s.kind !== 'wrapped' || !s.sockPath) disposePreview(id);
  }
}

window.addEventListener('resize', () => { for (const pv of previews.values()) fitPreview(pv); });
// uptime ticks every second without rebuilding cards (keeps focus + previews)
setInterval(() => {
  document.querySelectorAll<HTMLElement>('.uptime[data-started]').forEach((el) => {
    const t = Number(el.dataset.started); if (t) el.textContent = `uptime ${fmtUptime(Date.now() - t)}`;
  });
}, 1000);

reconcile();
connect();
