import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { bootstrapDaemon, type DaemonHandle } from '../bootstrap.js';
import { request } from '../../ipc/client.js';
import type { IMAdapter, IMChannel, OutgoingMessage, IncomingEnvelope } from '../../contracts/im-adapter.js';

let tmp: string;
let h: DaemonHandle;
let sock: string;
const sockets: WebSocket[] = [];

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-evt-')); sock = join(tmp, 'daemon.sock'); });
afterEach(async () => { for (const ws of sockets.splice(0)) ws.close(); await h?.shutdown(); });

function makeFakeAdapter(channel: IMChannel): IMAdapter {
  return {
    channel,
    async start() { /* noop */ },
    async stop() { /* noop */ },
    async send(_out: OutgoingMessage) { return { messageId: 'm1' }; },
    async edit() { /* noop */ },
    onInbound(_handler: (e: IncomingEnvelope) => void) { /* noop */ },
    isConnected() { return 'connected'; },
  };
}

async function openEventsWs(): Promise<{ frames: Array<Record<string, any>>; ws: WebSocket }> {
  const url = new URL(h.webUrl!);
  const frames: Array<Record<string, any>> = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://${url.host}/ws/events?token=${url.searchParams.get('token')}`);
    sockets.push(s);
    s.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString())));
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });
  return { frames, ws };
}

async function openEvents(): Promise<Array<Record<string, any>>> {
  return (await openEventsWs()).frames;
}

async function waitFor(frames: Array<Record<string, any>>, pred: (f: Record<string, any>) => boolean, ms = 4000): Promise<Record<string, any>> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = frames.find(pred);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('frame not seen: ' + JSON.stringify(frames));
}

describe('daemon → /ws/events downstream broadcast', () => {
  it('broadcasts a hook.event activity and reflects it in /api/sessions', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    const frames = await openEvents();
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/repo/a', sessionId: 's', toolName: 'Bash', result: {} } }, { socketPath: sock, timeoutMs: 2000 });
    // Registry key is the session id, not the cwd (two sessions in one directory
    // must not collide) — the cwd is still carried as a separate field.
    const f = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's');
    expect(f.session.status).toBe('active');
    expect(f.session.cwd).toBe('/repo/a');
    const url = new URL(h.webUrl!);
    const api = await fetch(`${url.origin}/api/sessions${url.search}`);
    const arr = (await api.json()) as Array<Record<string, any>>;
    expect(arr.find((s) => s.id === 's')?.status).toBe('active');
  });

  it('broadcasts session.register (upsert) and session.unregister (remove)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    const frames = await openEvents();
    await request({ kind: 'session.register', session: { id: 'u1', label: 'l', cmd: 'claude', cwd: '/repo/b', pid: 1, sockPath: '/s.sock' } }, { socketPath: sock, timeoutMs: 2000 });
    const up = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 'u1');
    expect(up.session.kind).toBe('wrapped');
    await request({ kind: 'session.unregister', id: 'u1' }, { socketPath: sock, timeoutMs: 2000 });
    const rm = await waitFor(frames, (x) => x.type === 'session-remove' && x.id === 'u1');
    expect(rm).toBeTruthy();
  });

  it('Stop hook (hook.continue.request) broadcasts waiting-input + drives ContinueBroker', async () => {
    // Capture the IM message that bootstrap sends on continue request (contains requestId).
    let capturedMsg = '';
    const adapter = makeFakeAdapter('telegram');
    const origSend = adapter.send.bind(adapter);
    adapter.send = async (out: OutgoingMessage) => {
      capturedMsg = out.kind === 'text' ? out.text : (out.body ?? '');
      return origSend(out);
    };
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const frames = await openEvents();

    // Fire the blocking continue request in the background.
    const p = request(
      { kind: 'hook.continue.request', cwd: '/stop/cwd', sessionId: 's', context: 'stop ctx', lastMessage: 'last_msg' },
      { socketPath: sock, timeoutMs: 8000 },
    );

    // Effect 1: broadcast waiting-input with lastMessage. Keyed by session id
    // ('s'), not by cwd — two sessions in '/stop/cwd' would otherwise collide.
    const f = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.status === 'waiting-input');
    expect(f.session.lastMessage).toBe('last_msg');

    // Effect 2: ContinueBroker received the request → IM message sent containing requestId.
    await new Promise((r) => setTimeout(r, 100));
    expect(capturedMsg).toMatch(/last_msg/); // excerpt = 真正的最后一句
    // requestId no longer appears in the display text — take it from the registry
    const continueId = h.sessions.get('s')!.continueId!;
    expect(continueId).toMatch(/[a-f0-9-]{36}/);

    // Unblock the IPC handler by answering the broker.
    h.continueBroker.answer(continueId, 'go');
    await p;
  });

  it('sets registry.pending on approval-ask and clears it on answer', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [makeFakeAdapter('telegram')] });
    const frames = await openEvents();
    // fire the blocking permission request in the background
    const p = request({ kind: 'hook.permission.request', cwd: '/repo/c', sessionId: 's', toolName: 'Bash', input: { command: 'ls' } }, { socketPath: sock, timeoutMs: 5000 });
    const ask = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.status === 'waiting-approval');
    expect(ask.session.pending?.title).toContain('Bash');
    const reqId = ask.session.pending.requestId as string;
    await request({ kind: 'hook.permission.answer', requestId: reqId, approved: true }, { socketPath: sock, timeoutMs: 2000 });
    await p;
    const cleared = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.status === 'active');
    expect(cleared.session.pending).toBeUndefined();
  });

  it('permission-request as a session\'s FIRST event keeps key and cwd separate — id=sessionId, cwd=real dir, label=basename(real dir) (Task 5 review, Important: PermissionRouter key/cwd conflation)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [makeFakeAdapter('telegram')] });
    const frames = await openEvents();
    // Deliberately no session-start (or any other) event seeded first — this
    // permission-request IS the session's only/first event. Before the fix,
    // bootstrap.ts fed the resolved key into PermissionRouter's single `cwd`
    // opt, so the registry upsert wrote the key into BOTH id and cwd.
    const p = request(
      { kind: 'hook.permission.request', cwd: '/real/project/dir', sessionId: 'sess-xyz', toolName: 'Bash', input: { command: 'ls' } },
      { socketPath: sock, timeoutMs: 5000 },
    );
    const ask = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.status === 'waiting-approval');
    expect(ask.session.id).toBe('sess-xyz'); // registry key = the session id, never the cwd
    expect(ask.session.cwd).toBe('/real/project/dir'); // real cwd threaded through separately from the key
    expect(ask.session.label).toBe('dir'); // basename(real cwd) — not basename(key)
    // Settle so the pending request doesn't dangle past the test.
    await request({ kind: 'hook.permission.answer', requestId: ask.session.pending.requestId, approved: true }, { socketPath: sock, timeoutMs: 2000 });
    await p;
  });

  it('AskUserQuestion does NOT broadcast a pending session to /ws/events — the dashboard\'s generic Allow/Deny buttons would misanswer it (Task 9 review, Important)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { port: 0 },
      approvals: { approvalGraceSec: 0, continueGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    let inboundHandler: ((e: IncomingEnvelope) => void) | undefined;
    const sentIm: OutgoingMessage[] = [];
    const askAdapter: IMAdapter = {
      channel: 'telegram',
      async start() { /* noop */ },
      async stop() { /* noop */ },
      async send(out: OutgoingMessage) { sentIm.push(out); return { messageId: `m${sentIm.length}` }; },
      async edit() { /* noop */ },
      onInbound(handler) { inboundHandler = handler; },
      isConnected() { return 'connected'; },
    };
    h = await bootstrapDaemon({ home: tmp, imAdapters: [askAdapter] });
    const frames = await openEvents();
    const p = request(
      {
        kind: 'hook.permission.request', cwd: '/repo/ask', sessionId: 's', toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    // give both the IM card and any (incorrect) web broadcast time to land
    await new Promise((r) => setTimeout(r, 150));
    expect(sentIm).toHaveLength(1); // IM still gets the ask card with option buttons
    // Registry key is the session id ('s'), not the cwd — assert the real
    // new-model identity, or this guards nothing (Task 5 review, Important:
    // the old '/repo/ask' assertion is vacuously true under the new model,
    // since no frame ever carries that id regardless of suppression).
    expect(frames.some((f) => f.type === 'session-upsert' && f.session.id === 's')).toBe(false);

    // Settle the pending permission request via IM (Skip) so it doesn't dangle past the test.
    const card = sentIm[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const skip = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
    inboundHandler?.({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skip.id, ts: 0 });
    await p;
  });

  it('upstream approve action over /ws/events resolves the permission request', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [makeFakeAdapter('telegram')] });
    const { frames, ws } = await openEventsWs();
    const p = request({ kind: 'hook.permission.request', cwd: '/repo/act', sessionId: 's', toolName: 'Bash', input: { command: 'ls' } }, { socketPath: sock, timeoutMs: 5000 });
    const ask = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.status === 'waiting-approval');
    ws.send(JSON.stringify({ type: 'approve', requestId: ask.session.pending.requestId, approved: false }));
    const res = (await p) as { decision: string };
    expect(res.decision).toBe('deny');
  });

  it('upstream reply action over /ws/events answers the continue broker (session carries continueId)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    const { frames, ws } = await openEventsWs();
    const p = request({ kind: 'hook.continue.request', cwd: '/stop/x', sessionId: 's', context: 'ctx', lastMessage: 'lm' }, { socketPath: sock, timeoutMs: 8000 });
    const wait = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.continueId);
    ws.send(JSON.stringify({ type: 'reply', requestId: wait.session.continueId, text: 'keep going' }));
    const res = (await p) as { reply: string | null };
    expect(res.reply).toBe('keep going');
    // continueId cleared, status back to active
    const done = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.status === 'active');
    expect(done.session.continueId).toBeUndefined();
  });

  it('continue grace: a new prompt within the grace window suppresses the card and replies null fast', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 8 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    const sent: string[] = [];
    const adapter = makeFakeAdapter('telegram');
    adapter.send = async (out: OutgoingMessage) => { sent.push(out.kind === 'text' ? out.text : (out.body ?? '')); return { messageId: 'm1' }; };
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const t0 = Date.now();
    const p = request({ kind: 'hook.continue.request', cwd: '/g', sessionId: 's', context: 'ctx' }, { socketPath: sock, timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 150));
    // user starts a new turn within the grace window → suppress the continue card
    await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/g', sessionId: 's', prompt: 'next' } }, { socketPath: sock, timeoutMs: 2000 });
    const res = (await p) as { reply: string | null };
    expect(res.reply).toBeNull();
    expect(Date.now() - t0).toBeLessThan(4000); // returned fast — did not wait the full 8s grace
    expect(sent).toHaveLength(0); // no continue card was ever sent
  });

  it('upstream mute action over /ws/events toggles per-session mute and re-broadcasts', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    const { frames, ws } = await openEventsWs();
    // create the session first
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/repo/m', sessionId: 's', toolName: 'Bash', result: {} } }, { socketPath: sock, timeoutMs: 2000 });
    await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's');
    ws.send(JSON.stringify({ type: 'mute', id: 's', muted: true }));
    const muted = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.muted === true);
    expect(muted.session.muted).toBe(true);
  });


  it('approval cards get a session tag and are edited to their outcome on resolve', async () => {
    const sent: Array<{ kind: string; title?: string; body?: string }> = [];
    const edits: Array<{ messageId: string; title?: string }> = [];
    const adapter = makeFakeAdapter('telegram');
    adapter.send = async (out: OutgoingMessage) => {
      sent.push(out.kind === 'card' ? { kind: 'card', title: out.title, body: out.body } : { kind: 'text' });
      return { messageId: `m${sent.length}` };
    };
    adapter.edit = async (messageId: string, out: OutgoingMessage) => {
      edits.push({ messageId, ...(out.kind === 'card' ? { title: out.title } : {}) });
    };
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0, approvalGraceSec: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    // seed the session so the card gets a label tag
    await request({ kind: 'hook.event', event: { event: 'session-start', cwd: '/tag/repo', sessionId: 's', source: 'startup' } }, { socketPath: sock, timeoutMs: 2000 });
    const p = request({ kind: 'hook.permission.request', cwd: '/tag/repo', sessionId: 's', toolName: 'Edit', input: { file_path: '/x', old_string: 'a', new_string: 'b' } }, { socketPath: sock, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 150));
    const card = sent.find((s) => s.kind === 'card');
    expect(card?.title).toContain('repo · '); // session tag prefix (still basename(cwd) — label is unaffected by the key change)
    // answer → card edited to outcome. Keyed by session id ('s'), not cwd.
    const reqId = h.sessions.get('s')!.pending!.requestId;
    await request({ kind: 'hook.permission.answer', requestId: reqId, approved: false }, { socketPath: sock, timeoutMs: 2000 });
    await p;
    await new Promise((r) => setTimeout(r, 100));
    expect(edits.length).toBe(1);
    expect(edits[0].title).toContain('Denied');
  });

  it('web approve with alwaysAllowTool auto-allows the next request for that tool', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [makeFakeAdapter('telegram')] });
    const { frames, ws } = await openEventsWs();
    const p = request({ kind: 'hook.permission.request', cwd: '/aa', sessionId: 's', toolName: 'Edit', input: {} }, { socketPath: sock, timeoutMs: 5000 });
    const ask = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.status === 'waiting-approval');
    expect(ask.session.pending.toolName).toBe('Edit');
    ws.send(JSON.stringify({ type: 'approve', requestId: ask.session.pending.requestId, approved: true, alwaysAllowTool: 'Edit' }));
    expect(((await p) as { decision: string }).decision).toBe('allow');
    // next Edit request auto-allows without a card
    const r2 = await request({ kind: 'hook.permission.request', cwd: '/aa', sessionId: 's', toolName: 'Edit', input: {} }, { socketPath: sock, timeoutMs: 3000 });
    expect((r2 as { decision: string }).decision).toBe('allow');
  });


  it('hook events with wrappedId land on that exact card — two wrapped sessions share one cwd', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    const frames = await openEvents();
    // two wrapped sessions in the SAME cwd
    await request({ kind: 'session.register', session: { id: 'w-a', label: 'claude', cmd: 'claude', cwd: '/same', pid: 1, sockPath: '/a.sock' } }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'session.register', session: { id: 'w-b', label: 'bash', cmd: 'bash', cwd: '/same', pid: 2, sockPath: '/b.sock' } }, { socketPath: sock, timeoutMs: 2000 });
    // hook activity from INSIDE session w-a (TLIVE_SESSION → wrappedId)
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/same', sessionId: 's', toolName: 'Bash', result: {} }, wrappedId: 'w-a' }, { socketPath: sock, timeoutMs: 2000 });
    const f = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 'w-a' && x.session.status === 'active');
    expect(f.session.sockPath).toBe('/a.sock'); // merged into w-a, not w-b, no third card
    const api = await fetch(`${new URL(h.webUrl!).origin}/api/sessions${new URL(h.webUrl!).search}`);
    const arr = (await api.json()) as Array<Record<string, any>>;
    expect(arr).toHaveLength(2); // still exactly two cards
    // hook event WITHOUT wrappedId (bare claude in the same dir) → its own hook
    // card, keyed by its OWN session id ('s2'), not by the shared cwd '/same'.
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/same', sessionId: 's2', toolName: 'Read', result: {} } }, { socketPath: sock, timeoutMs: 2000 });
    await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's2' && x.session.kind === 'hook');
  });


  it('a wrappedId hook event BEFORE session.register keys by uuid (no phantom cwd card)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    h = await bootstrapDaemon({ home: tmp });
    const frames = await openEvents();
    // hook fires from inside the wrapper before register lands (the run.ts race)
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/race', sessionId: 's', toolName: 'Bash', result: {} }, wrappedId: 'w-race' }, { socketPath: sock, timeoutMs: 2000 });
    const f = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 'w-race');
    expect(f.session.id).toBe('w-race'); // keyed by uuid, NOT by cwd
    // register now merges into the SAME uuid card and promotes it to wrapped
    await request({ kind: 'session.register', session: { id: 'w-race', label: 'claude', cmd: 'claude', cwd: '/race', pid: 1, sockPath: '/r.sock' } }, { socketPath: sock, timeoutMs: 2000 });
    await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 'w-race' && x.session.kind === 'wrapped');
    const api = await fetch(`${new URL(h.webUrl!).origin}/api/sessions${new URL(h.webUrl!).search}`);
    const arr = (await api.json()) as Array<Record<string, any>>;
    expect(arr).toHaveLength(1); // exactly one card — no phantom '/race' hook card
    expect(arr[0].id).toBe('w-race');
  });

  it('concurrent approvals on one key: resolving the first keeps the second pending', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [makeFakeAdapter('telegram')] });
    const frames = await openEvents();
    const pA = request({ kind: 'hook.permission.request', cwd: '/cc', sessionId: 's', toolName: 'Bash', input: { command: 'a' } }, { socketPath: sock, timeoutMs: 5000 });
    const fa = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.pending);
    const reqA = fa.session.pending.requestId as string;
    const pB = request({ kind: 'hook.permission.request', cwd: '/cc', sessionId: 's', toolName: 'Write', input: {} }, { socketPath: sock, timeoutMs: 5000 });
    const fb = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.pending && x.session.pending.requestId !== reqA);
    const reqB = fb.session.pending.requestId as string;
    // resolve A (deny) — must NOT wipe B's pending indicator
    await request({ kind: 'hook.permission.answer', requestId: reqA, approved: false }, { socketPath: sock, timeoutMs: 2000 });
    expect(((await pA) as { decision: string }).decision).toBe('deny');
    await new Promise((r) => setTimeout(r, 80));
    expect(h.sessions.get('s')?.pending?.requestId).toBe(reqB);
    // cleanup
    await request({ kind: 'hook.permission.answer', requestId: reqB, approved: false }, { socketPath: sock, timeoutMs: 2000 });
    await pB;
  });


  it('session.activity flips running/idle but never overrides a hook wait', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, approvals: { continueGraceSec: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [makeFakeAdapter('telegram')] });
    const frames = await openEvents();
    await request({ kind: 'session.register', session: { id: 'w1', label: 'bash', cmd: 'bash', cwd: '/act', pid: 1, sockPath: '/a.sock' } }, { socketPath: sock, timeoutMs: 2000 });
    // idle → then active
    await request({ kind: 'session.activity', id: 'w1', active: false }, { socketPath: sock, timeoutMs: 2000 });
    await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 'w1' && x.session.status === 'idle');
    await request({ kind: 'session.activity', id: 'w1', active: true }, { socketPath: sock, timeoutMs: 2000 });
    await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 'w1' && x.session.status === 'active');
    // now a hook approval → waiting-approval; activity(idle) must NOT clear it
    const p = request({ kind: 'hook.permission.request', cwd: '/act', sessionId: 's', toolName: 'Bash', input: {}, wrappedId: 'w1' }, { socketPath: sock, timeoutMs: 5000 });
    await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 'w1' && x.session.status === 'waiting-approval');
    await request({ kind: 'session.activity', id: 'w1', active: false }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 60));
    expect(h.sessions.get('w1')?.status).toBe('waiting-approval'); // unchanged
    await request({ kind: 'hook.permission.answer', requestId: h.sessions.get('w1')!.pending!.requestId, approved: false }, { socketPath: sock, timeoutMs: 2000 });
    await p;
  });

  describe('hook.notify droppable (Fix 3b: suppression lives in the daemon, not the shim)', () => {
    // A prior fix made the shim short-circuit droppable attention events before
    // hook.notify IPC even fired, which also erased the dashboard's only view of
    // that tool failure (PostToolUse and PostToolUseFailure are mutually
    // exclusive per CC docs — no activity event ever substitutes). The fix now
    // lives here: the daemon still gets the event and always broadcasts it to
    // the dashboard; only the IM send is skipped when droppable is set.
    it('droppable:true → IM never gets a message, but the dashboard still sees the attention', async () => {
      const sent: string[] = [];
      const adapter = makeFakeAdapter('telegram');
      adapter.send = async (out: OutgoingMessage) => { sent.push(out.kind === 'text' ? out.text : (out.body ?? '')); return { messageId: 'm1' }; };
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const frames = await openEvents();

      const res = await request(
        { kind: 'hook.notify', cwd: '/drop/repo', sessionId: 's', level: 'error', message: 'Bash failed (no error output)', droppable: true },
        { socketPath: sock, timeoutMs: 2000 },
      );
      expect(res.kind).toBe('ack');

      // Effect 1 (must hold): dashboard still gets the attention — this event is
      // its only view of the failed tool call.
      const f = await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.status === 'waiting-input');
      expect(f.session.lastMessage).toBe('Bash failed (no error output)');

      // Effect 2 (must hold): IM adapter.send was never invoked for this notify.
      await new Promise((r) => setTimeout(r, 100));
      expect(sent).toHaveLength(0);
    });

    it('a non-droppable failure (real error content) still reaches both IM and the dashboard', async () => {
      const sent: string[] = [];
      const adapter = makeFakeAdapter('telegram');
      adapter.send = async (out: OutgoingMessage) => { sent.push(out.kind === 'text' ? out.text : (out.body ?? '')); return { messageId: 'm1' }; };
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const frames = await openEvents();

      await request(
        { kind: 'hook.notify', cwd: '/real/repo', sessionId: 's', level: 'error', message: 'Bash failed: permission denied' },
        { socketPath: sock, timeoutMs: 2000 },
      );

      await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's' && x.session.lastMessage === 'Bash failed: permission denied');
      await new Promise((r) => setTimeout(r, 100));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('permission denied');
    });

    it('a plain notification (no droppable field at all) is unaffected — IM + dashboard both fire as before', async () => {
      const sent: string[] = [];
      const adapter = makeFakeAdapter('telegram');
      adapter.send = async (out: OutgoingMessage) => { sent.push(out.kind === 'text' ? out.text : (out.body ?? '')); return { messageId: 'm1' }; };
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 }, adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } } }));
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const frames = await openEvents();

      await request(
        { kind: 'hook.notify', cwd: '/notif/repo', sessionId: 's', level: 'info', message: 'needs your attention' },
        { socketPath: sock, timeoutMs: 2000 },
      );

      await waitFor(frames, (x) => x.type === 'session-upsert' && x.session.id === 's');
      await new Promise((r) => setTimeout(r, 100));
      expect(sent).toHaveLength(1);
    });
  });

});
