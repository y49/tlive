// web/src/dashboard.ts — tlive session dashboard.
// Lightweight preview + interaction over /ws/events (JSON, bidirectional): renders
// one card per session (status / staleness / Claude's last line) and sends upstream
// approve / reply / mute actions. Open-terminal is a plain link to /s/<id>.

import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { FrameType, FrameDecoder, encodeAttach, parseDims } from './frame.js';

const token = new URLSearchParams(location.search).get('token') ?? '';

type Status = 'active' | 'waiting-approval' | 'waiting-input' | 'idle';
interface Pending { requestId: string; title: string; body: string; toolName?: string }
interface SessionView {
  id: string; label: string; cwd: string;
  kind: 'wrapped' | 'hook'; status: Status;
  lastActivityAt: number; lastMessage?: string; lastPrompt?: string;
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
  sock.onopen = () => {
    retry = 0; conn.textContent = 'live'; conn.className = 'up';
    // Reconcile after (re)connect: frames missed while disconnected (e.g. a
    // session-remove) would otherwise leave ghost cards forever.
    void reconcile();
  };
  sock.onmessage = (ev) => {
    let f: Frame;
    try { f = JSON.parse(String(ev.data)); } catch { return; }
    if (f.type === 'session-upsert') sessions.set(f.session.id, f.session);
    else if (f.type === 'session-remove') sessions.delete(f.id);
    render();
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    conn.textContent = 'reconnecting…'; conn.className = 'down';
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * retry);
  };
  sock.onerror = () => sock.close();
}

// Full reconcile from the REST list: seed on load AND correct drift after a
// ws reconnect (adds missing sessions, drops ones that no longer exist).
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

function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}` : `${m}m`;
}

function staleness(s: SessionView): string {
  if (s.status !== 'waiting-approval' && s.status !== 'waiting-input') return '';
  const ms = Date.now() - s.lastActivityAt;
  return ms >= 60000 ? `⏱ stuck ${fmtDur(ms)}` : '';
}

const STATUS_LABEL: Record<Status, string> = {
  'active': 'running', 'idle': 'idle', 'waiting-approval': 'needs approval', 'waiting-input': 'awaiting reply',
};

function esc(t: string): string {
  const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
}
/** Escape for an HTML ATTRIBUTE value (esc() alone leaves quotes intact → an
 *  attribute-injection XSS when a cwd/path contains a `"`). */
function escAttr(t: string): string {
  return esc(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Reply drafts survive card rebuilds (render() replaces every card on each
 *  frame, which would otherwise wipe an in-progress reply). Keyed by session id. */
const replyDrafts = new Map<string, string>();

/** Render the markdown-ish approval body (fences + diff lines) with colors. */
function renderApprovalBody(body: string): string {
  const out: string[] = [];
  let fence: string | null = null; // 'diff' | 'bash' | other
  for (const raw of body.split('\n')) {
    const m = raw.match(/^```(\w*)/);
    if (m) { fence = fence === null ? (m[1] || 'txt') : null; continue; }
    const line = esc(raw);
    if (fence === 'diff') {
      if (raw.startsWith('+')) { out.push(`<span class="d-add">${line}</span>`); continue; }
      if (raw.startsWith('-')) { out.push(`<span class="d-del">${line}</span>`); continue; }
      if (raw.startsWith('@@')) { out.push(`<span class="d-hunk">${line}</span>`); continue; }
    } else if (fence === 'bash') {
      out.push(`<span class="d-cmd">${line}</span>`); continue;
    }
    if (raw.includes('⚠️')) { out.push(`<span class="d-del">${line.replace(/\*\*/g, '')}</span>`); continue; }
    // `inline code` outside fences → dim
    out.push(line.replace(/`([^`]+)`/g, '<span class="k">$1</span>'));
  }
  return out.join('\n');
}

// ---- live terminal previews (wrapped sessions) --------------------------------
// One read-only mini xterm per wrapped session, fed by its own /ws/term socket.
// Cached by session id so re-renders MOVE the element instead of reconnecting.
// The preview never sends Data frames, so it never steals size authority.

interface Preview { el: HTMLElement; term: Terminal; ws: WebSocket | null; dead: boolean }
const previews = new Map<string, Preview>();

function fitPreview(pv: Preview): void {
  const inner = pv.el.firstElementChild as HTMLElement; // scaler
  const t = inner.firstElementChild as HTMLElement;     // xterm root
  if (!t || t.offsetWidth === 0) return;
  // Fit by WIDTH so the preview fills the card. Height adapts up to a cap;
  // when clipped, pin the BOTTOM of the screen (TUI prompt/status live there).
  const s = pv.el.clientWidth / t.offsetWidth;
  const scaledH = Math.ceil(t.offsetHeight * s);
  const h = Math.min(220, scaledH);
  inner.style.transform = `scale(${s})`;
  pv.el.style.height = `${h}px`;
  inner.style.top = `${Math.min(0, h - scaledH)}px`;
}

function createPreview(id: string): Preview {
  const el = document.createElement('div');
  el.className = 'preview';
  const scaler = document.createElement('div');
  scaler.className = 'pv-scaler';
  el.appendChild(scaler);
  const term = new Terminal({ disableStdin: true, fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace', theme: { background: '#0d1015' }, scrollback: 0 });
  term.open(scaler);
  const pv: Preview = { el, term, ws: null, dead: false };
  el.addEventListener('click', () => { window.open(`/s/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, '_blank'); });

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let retry = 0;
  const connect = (): void => {
    if (pv.dead) return;
    const dec = new FrameDecoder();
    const sock = new WebSocket(`${proto}://${location.host}/ws/term/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`);
    sock.binaryType = 'arraybuffer';
    pv.ws = sock;
    // Attach with 0×0: joins as a size-less client (never affects the grid),
    // and the late-joiner rule immediately sends us the authoritative Size.
    sock.onopen = () => { retry = 0; sock.send(encodeAttach(0, 0)); };
    sock.onmessage = (ev) => {
      for (const f of dec.push(new Uint8Array(ev.data as ArrayBuffer))) {
        if (f.type === FrameType.Data) term.write(f.payload);
        else if (f.type === FrameType.Size) {
          const { cols, rows } = parseDims(f.payload);
          term.resize(cols, rows);
          requestAnimationFrame(() => fitPreview(pv));
        }
      }
    };
    sock.onclose = () => { if (!pv.dead) { retry = Math.min(retry + 1, 6); setTimeout(connect, 1000 * retry); } };
    sock.onerror = () => sock.close();
  };
  connect();
  previews.set(id, pv);
  return pv;
}

function disposePreview(id: string): void {
  const pv = previews.get(id);
  if (!pv) return;
  pv.dead = true;
  try { pv.ws?.close(); } catch { /* ignore */ }
  pv.term.dispose();
  pv.el.remove();
  previews.delete(id);
}

function card(s: SessionView): HTMLElement {
  const el = document.createElement('div');
  el.className = `card st-${s.status}`;

  const top = document.createElement('div');
  top.className = 'top';
  const badge = staleness(s);
  top.innerHTML =
    `<span class="label" title="${escAttr(s.cwd)}">${esc(s.label)}</span>` +
    `<span class="badge ${s.status}">${STATUS_LABEL[s.status]}</span>` +
    (badge ? `<span class="stale">${badge}</span>` : '');
  el.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML =
    (s.pid !== undefined ? `<span class="pid">PID ${Number(s.pid)}</span>` : '') +
    `<span class="path" title="${escAttr(s.cwd)}">${esc(s.cwd)}</span>`;
  el.appendChild(meta);

  if (s.kind === 'wrapped' && s.sockPath) {
    const pv = previews.get(s.id) ?? createPreview(s.id);
    el.appendChild(pv.el);
    requestAnimationFrame(() => fitPreview(pv));
  }

  if (s.pending) {
    const m = document.createElement('div');
    m.className = 'msg approval';
    m.innerHTML = `<span class="k">${esc(s.pending.title)}</span>\n${renderApprovalBody(s.pending.body)}`;
    el.appendChild(m);
  } else if (s.lastMessage) {
    const m = document.createElement('div');
    m.className = 'msg';
    m.innerHTML = `<span class="k">last:</span> ${esc(s.lastMessage)}`;
    el.appendChild(m);
  } else if (s.lastPrompt) {
    const m = document.createElement('div');
    m.className = 'msg';
    m.innerHTML = `<span class="k">prompt:</span> ${esc(s.lastPrompt)}`;
    el.appendChild(m);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  if (s.pending) {
    const rid = s.pending.requestId;
    const tool = s.pending.toolName;
    const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = '✅ Allow';
    ok.onclick = () => send({ type: 'approve', requestId: rid, approved: true });
    const no = document.createElement('button'); no.className = 'no'; no.textContent = '❌ Deny';
    no.onclick = () => send({ type: 'approve', requestId: rid, approved: false });
    actions.append(ok, no);
    if (tool) {
      const always = document.createElement('button'); always.className = 'ok';
      always.textContent = `✅ Always allow ${tool}`;
      always.title = 'Allow now AND auto-allow this tool until the daemon restarts';
      always.onclick = () => send({ type: 'approve', requestId: rid, approved: true, alwaysAllowTool: tool });
      actions.append(always);
    }
  }

  const mute = document.createElement('button');
  mute.className = s.muted ? 'on' : '';
  mute.textContent = s.muted ? '🔔' : '🔕';
  mute.title = s.muted ? 'Unmute: resume IM cards/notifications for this session' : 'Mute: stop sending this session\'s IM cards/notifications';
  mute.onclick = () => send({ type: 'mute', id: s.id, muted: !s.muted });
  actions.appendChild(mute);

  if (s.sockPath) {
    // 📎 upload a file → inject its inbox path into the session's pty
    const clip = document.createElement('button');
    clip.textContent = '📎';
    clip.title = 'Send a file/photo to this session (uploads, then types the path)';
    clip.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true;
      input.onchange = async () => {
        const paths: string[] = [];
        for (const f of Array.from(input.files ?? [])) {
          try {
            const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}&token=${encodeURIComponent(token)}`, { method: 'POST', body: f });
            if (res.ok) paths.push(((await res.json()) as { path: string }).path);
          } catch { /* skip */ }
        }
        if (paths.length) send({ type: 'inject', id: s.id, text: paths.join(' ') });
      };
      input.click();
    };
    actions.appendChild(clip);

    const link = document.createElement('a');
    link.className = 'term';
    link.href = `/s/${encodeURIComponent(s.id)}?token=${encodeURIComponent(token)}`;
    link.target = '_blank'; link.rel = 'noopener';
    const b = document.createElement('button'); b.textContent = '🖥 Terminal';
    link.appendChild(b);
    actions.appendChild(link);
  }
  el.appendChild(actions);

  if (s.status === 'waiting-input' && s.continueId) {
    const cid = s.continueId;
    const row = document.createElement('div');
    row.className = 'reply';
    const input = document.createElement('input');
    input.className = 'reply-input';
    input.dataset.sid = s.id;
    input.placeholder = 'reply to continue…';
    input.value = replyDrafts.get(s.id) ?? ''; // survive card rebuilds
    input.oninput = () => { replyDrafts.set(s.id, input.value); };
    const btn = document.createElement('button'); btn.className = 'ok'; btn.textContent = 'Send';
    const fire = () => { const t = input.value.trim(); if (t) { send({ type: 'reply', requestId: cid, text: t }); replyDrafts.delete(s.id); input.value = ''; } };
    btn.onclick = fire;
    input.onkeydown = (e) => { if (e.key === 'Enter') fire(); };
    row.append(input, btn);
    el.appendChild(row);
  }

  return el;
}

// Order: needs-attention first (approval, then waiting-input), then most-recent activity.
const RANK: Record<Status, number> = { 'waiting-approval': 0, 'waiting-input': 1, 'active': 2, 'idle': 3 };

function render(): void {
  const list = [...sessions.values()].sort((a, b) =>
    RANK[a.status] - RANK[b.status] || b.lastActivityAt - a.lastActivityAt);
  empty.style.display = list.length ? 'none' : 'block';
  count.textContent = String(list.length);
  // Preserve focus + caret across the rebuild (a reply input being typed into).
  const active = document.activeElement as HTMLInputElement | null;
  const focusSid = active?.classList.contains('reply-input') ? active.dataset.sid : undefined;
  const caret = active?.selectionStart ?? null;
  grid.replaceChildren(...list.map(card));
  if (focusSid) {
    const next = grid.querySelector(`.reply-input[data-sid="${CSS.escape(focusSid)}"]`) as HTMLInputElement | null;
    if (next) { next.focus(); if (caret != null) try { next.setSelectionRange(caret, caret); } catch { /* ignore */ } }
  }
  // Reap previews for sessions that no longer exist (or lost their pty).
  for (const id of [...previews.keys()]) {
    const s = sessions.get(id);
    if (!s || s.kind !== 'wrapped' || !s.sockPath) disposePreview(id);
  }
}
window.addEventListener('resize', () => { for (const pv of previews.values()) fitPreview(pv); });

reconcile();
connect();
// Refresh staleness once a minute (lastActivityAt is server-stamped; the label drifts otherwise).
setInterval(render, 60000);
