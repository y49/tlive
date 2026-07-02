// web/src/dashboard.ts — tlive session dashboard.
// Lightweight preview + interaction over /ws/events (JSON, bidirectional): renders
// one card per session (status / staleness / Claude's last line) and sends upstream
// approve / reply / mute actions. Open-terminal is a plain link to /s/<id>.

const token = new URLSearchParams(location.search).get('token') ?? '';

type Status = 'active' | 'waiting-approval' | 'waiting-input' | 'idle';
interface Pending { requestId: string; title: string; body: string }
interface SessionView {
  id: string; label: string; cwd: string;
  kind: 'wrapped' | 'hook'; status: Status;
  lastActivityAt: number; lastMessage?: string; lastPrompt?: string;
  pending?: Pending; continueId?: string; muted: boolean; sockPath?: string;
}
type Frame =
  | { type: 'session-upsert'; session: SessionView }
  | { type: 'session-remove'; id: string };
type Action =
  | { type: 'approve'; requestId: string; approved: boolean }
  | { type: 'reply'; requestId: string; text: string }
  | { type: 'mute'; id: string; muted: boolean };

const sessions = new Map<string, SessionView>();
const grid = document.getElementById('grid') as HTMLElement;
const empty = document.getElementById('empty') as HTMLElement;
const conn = document.getElementById('conn') as HTMLElement;

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
  sock.onopen = () => { retry = 0; conn.textContent = 'live'; conn.className = 'up'; };
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

// Initial snapshot: /ws/events sends no backlog, so seed from the REST list.
async function snapshot(): Promise<void> {
  try {
    const res = await fetch(`/api/sessions?token=${encodeURIComponent(token)}`);
    if (!res.ok) return;
    for (const s of (await res.json()) as SessionView[]) if (!sessions.has(s.id)) sessions.set(s.id, s);
    render();
  } catch { /* ws will populate */ }
}

function staleness(s: SessionView): string {
  if (s.status !== 'waiting-approval' && s.status !== 'waiting-input') return '';
  const mins = Math.floor((Date.now() - s.lastActivityAt) / 60000);
  return mins >= 1 ? `⏱ stuck ${mins}m` : '';
}

const STATUS_LABEL: Record<Status, string> = {
  'active': 'active', 'idle': 'idle', 'waiting-approval': 'needs approval', 'waiting-input': 'waiting reply',
};

function esc(t: string): string {
  const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
}

function card(s: SessionView): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';

  const top = document.createElement('div');
  top.className = 'top';
  const badge = staleness(s);
  top.innerHTML =
    `<span class="label" title="${esc(s.cwd)}">${esc(s.label)}</span>` +
    `<span class="badge ${s.status}">${STATUS_LABEL[s.status]}</span>` +
    (badge ? `<span class="stale">${badge}</span>` : '');
  el.appendChild(top);

  const cwd = document.createElement('div');
  cwd.className = 'cwd'; cwd.textContent = s.cwd;
  el.appendChild(cwd);

  if (s.pending) {
    const m = document.createElement('div');
    m.className = 'msg';
    m.innerHTML = `<span class="k">${esc(s.pending.title)}</span>\n${esc(s.pending.body)}`;
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
    const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = '✅ Allow';
    ok.onclick = () => send({ type: 'approve', requestId: rid, approved: true });
    const no = document.createElement('button'); no.className = 'no'; no.textContent = '❌ Deny';
    no.onclick = () => send({ type: 'approve', requestId: rid, approved: false });
    actions.append(ok, no);
  }

  const mute = document.createElement('button');
  mute.className = s.muted ? 'on' : '';
  mute.textContent = s.muted ? '🔔 Unmute' : '🔕 Mute';
  mute.onclick = () => send({ type: 'mute', id: s.id, muted: !s.muted });
  actions.appendChild(mute);

  if (s.sockPath) {
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
    input.placeholder = 'reply to continue…';
    const btn = document.createElement('button'); btn.className = 'ok'; btn.textContent = 'Send';
    const fire = () => { const t = input.value.trim(); if (t) { send({ type: 'reply', requestId: cid, text: t }); input.value = ''; } };
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
  grid.replaceChildren(...list.map(card));
}

snapshot();
connect();
// Refresh staleness once a minute (lastActivityAt is server-stamped; the label drifts otherwise).
setInterval(render, 60000);
