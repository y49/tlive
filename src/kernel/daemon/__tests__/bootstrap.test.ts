import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapDaemon, shouldFastNullContinue, clampPermissionTimeout, makeCodexResumeHandler, shouldDropNotify, resolveKey, type DaemonHandle } from '../bootstrap';
import { request, daemonSocketPath } from '../../ipc/client';
import { AlreadyRunningError } from '../../ipc/server.js';
import type { IMAdapter, IMChannel, OutgoingMessage, IncomingEnvelope } from '../../contracts/im-adapter';
import { SessionRegistry } from '../../web/session-registry';
import { until } from '../../__tests__/wait.js';
import { writeMode } from '../../config/mode.js';
import { mdToTelegramHtml } from '../../../adapters/im/telegram-html.js';

// #45 — robustness helpers for this file's "held request" pattern
// (const pending = request(...); …asserts…; await pending). On a slow/jittery
// Windows named-pipe runner two things bit: (1) the fixed setTimeout before
// reading `sent[0]` wasn't always long enough → the read/assert threw; (2) that
// throw happened BEFORE `await pending`, abandoning the held request, which then
// rejected IpcConnectionClosedError at shutdown() with no handler attached → an
// unhandled rejection failed the whole run (#45's Windows "teardown noise").
// `held()` pre-attaches a no-op catch (the promise stays awaitable — a real
// reply/rejection still reaches `await pending`) so an abandoned request can
// never surface as unhandled. `waitForSent()` polls until the async card
// actually went out instead of guessing a fixed delay.
function held<T>(p: Promise<T>): Promise<T> {
  p.catch(() => { /* abandoned-at-teardown guard; `await pending` still observes it */ });
  return p;
}
async function waitForSent(sent: unknown[], n = 1): Promise<void> {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(n), { timeout: 3000, interval: 10 });
}

let tmp: string;
let h: DaemonHandle;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-d-')); });
afterEach(async () => { await h?.shutdown(); });

describe('daemon bootstrap', () => {
  it('starts and answers daemon.status', async () => {
    h = await bootstrapDaemon({ home: tmp });
    const r = await request({ kind: 'daemon.status' }, { socketPath: daemonSocketPath(tmp), timeoutMs: 2000 });
    expect(r.kind).toBe('daemon.status');
  });

  it('reports codex: off when the app-server custody cannot be established', async () => {
    h = await bootstrapDaemon({ home: tmp, ensureAppServer: async () => null });
    const r = await request({ kind: 'daemon.status' }, { socketPath: daemonSocketPath(tmp), timeoutMs: 2000 });
    expect(r).toMatchObject({ kind: 'daemon.status', codex: 'off' });
  });

  // The `desktop` runtime toggle was removed entirely (no separate on/off
  // switch for the toast — see refreshDesktop's doc comment). A stale CLI
  // still shipping `daemon.set key=desktop` must get a loud error, not
  // silently land on whichever branch happens to be last in the dispatch.
  it('daemon.set no longer accepts the retired desktop key', async () => {
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { render: async () => {}, clear: async () => {} } });
    const r = await request({ kind: 'daemon.set', key: 'desktop', enabled: false } as never, { socketPath: h.ipcSocketPath, timeoutMs: 2000 });
    expect(r.kind).toBe('error');
  });

  // I2: a second bootstrapDaemon() against the SAME home — the shape of
  // daemon/main.ts's response to AlreadyRunningError — must fail to bind
  // before it ever gets a chance to retract a toast. Before the fix, the
  // startup clear() ran ~650 lines before the IPC bind, so the LOSING
  // attempt would retract the SURVIVING daemon's toast on its way to exiting,
  // right when something was still genuinely waiting.
  it('a losing daemon whose IPC bind fails must never retract the surviving daemon\'s toast', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const winnerClears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { render: async () => {}, clear: async () => { winnerClears.push(1); } } });
    expect(winnerClears).toHaveLength(1); // its own genuine startup retraction

    const loserClears: number[] = [];
    await expect(
      bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { render: async () => {}, clear: async () => { loserClears.push(1); } } }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(loserClears).toHaveLength(0);
  });

  // No test asserted this before: deleting the shutdown `desktop.clear()`
  // call broke nothing, despite being half of the resident toast's safety
  // story (a daemon restart must not inherit a stale banner nothing owns).
  it('closes the resident toast on shutdown', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { render: async () => {}, clear: async () => { clears.push(1); } } });
    clears.length = 0; // discard the daemon's own startup clear
    await h.shutdown();
    expect(clears).toHaveLength(1);
  });
});

describe('dual-channel wiring helpers', () => {
  it('continue fast-nulls only when neither IM nor web can answer', () => {
    expect(shouldFastNullContinue(0, 0)).toBe(true);
    expect(shouldFastNullContinue(1, 0)).toBe(false);
    expect(shouldFastNullContinue(0, 1)).toBe(false);
  });
  it('clamps permission timeout to 24h and defaults to 580s', () => {
    expect(clampPermissionTimeout(undefined)).toBe(580);
    expect(clampPermissionTimeout(86_000)).toBe(86_000);
    expect(clampPermissionTimeout(999_999)).toBe(86_400);
  });
});

describe('resolveKey — one key per session, not per directory', () => {
  it('prefers the wrapped run id (already unique)', () => {
    expect(resolveKey('sess-1', '/w', 'run-uuid')).toBe('run-uuid');
  });

  it('uses the session id so two sessions in ONE directory never collide', () => {
    expect(resolveKey('sess-A', '/same/dir')).toBe('sess-A');
    expect(resolveKey('sess-B', '/same/dir')).toBe('sess-B');
    expect(resolveKey('sess-A', '/same/dir')).not.toBe(resolveKey('sess-B', '/same/dir'));
  });

  it('falls back to cwd when the session id is missing (normalizer yields "")', () => {
    expect(resolveKey('', '/w')).toBe('/w');
  });
});

describe('shouldDropNotify', () => {
  it('drops an info-level idle notify when a continue card is already pending for the session', () => {
    expect(shouldDropNotify('req-1', 'info')).toBe(true);
  });
  it('never drops an error-level failure notify, even with a continue card pending — a stale continueId (up to continueWindowSec, default 30min) must not silently eat a tool/stop failure alert', () => {
    expect(shouldDropNotify('req-1', 'error')).toBe(false);
  });
  it('keeps the notify when no continue card is outstanding, for both levels', () => {
    expect(shouldDropNotify(null, 'info')).toBe(false);
    expect(shouldDropNotify(undefined, 'info')).toBe(false);
    expect(shouldDropNotify(null, 'error')).toBe(false);
    expect(shouldDropNotify(undefined, 'error')).toBe(false);
  });
});

describe('makeCodexResumeHandler', () => {
  function fakeEvents(size = 1) {
    const broadcast = (v: unknown) => broadcasts.push(v);
    const broadcasts: unknown[] = [];
    return { broadcast, size: () => size, broadcasts };
  }

  it('reply path: resume called and active broadcast', async () => {
    const sessions = new SessionRegistry();
    const events = fakeEvents(1);
    const resume = async (_t: string, _i: string) => undefined;
    let resumeCall: [string, string] | undefined;
    const handler = makeCodexResumeHandler({
      broker: { request: async () => 'go on' },
      sessions,
      events,
      chats: () => [],
      resume: async (t, i) => { resumeCall = [t, i]; await resume(t, i); },
    });
    handler({ threadId: 't1', key: 'codex:t1', lastMessage: 'done' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(resumeCall).toEqual(['t1', 'go on']);
    expect(events.broadcasts.some((b: any) => b.session?.status === 'active')).toBe(true);
  });

  it('fast-null path: no channel → idle broadcast, broker/resume never called', async () => {
    const sessions = new SessionRegistry();
    const events = fakeEvents(0);
    let requested = false;
    let resumed = false;
    const handler = makeCodexResumeHandler({
      broker: { request: async () => { requested = true; return 'x'; } },
      sessions,
      events,
      chats: () => [],
      resume: async () => { resumed = true; },
    });
    handler({ threadId: 't1', key: 'codex:t1' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(requested).toBe(false);
    expect(resumed).toBe(false);
    expect(events.broadcasts.some((b: any) => b.session?.status === 'idle')).toBe(true);
  });

  it('null-reply path: idle broadcast, resume not called', async () => {
    const sessions = new SessionRegistry();
    const events = fakeEvents(1);
    let resumed = false;
    const handler = makeCodexResumeHandler({
      broker: { request: async () => null },
      sessions,
      events,
      chats: () => [],
      resume: async () => { resumed = true; },
    });
    handler({ threadId: 't1', key: 'codex:t1' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(resumed).toBe(false);
    expect(events.broadcasts.filter((b: any) => b.session?.status === 'idle').length).toBeGreaterThan(0);
  });
});

describe('local-answer cancel + Stop fast-null (integration)', () => {
  function fakeAdapter(channel: IMChannel): IMAdapter {
    return {
      channel,
      async start() { /* noop */ },
      async stop() { /* noop */ },
      async send(_out: OutgoingMessage) { return { messageId: 'm1' }; },
      async edit() { /* noop */ },
      onInbound(_h: (e: IncomingEnvelope) => void) { /* noop */ },
      isConnected() { return 'connected' as const; },
    };
  }

  it('a PostToolUse activity for the same key+tool releases the pending approval as defer', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [fakeAdapter('telegram')] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(h.sessions.get('s1')?.pending).toBeDefined(); }); // let the card go pending
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    const r = await pending;
    expect(r).toEqual({ kind: 'hook.permission.result', decision: 'defer' });
  });

  it('hook.continue.request replies null immediately with no IM and no web clients', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    h = await bootstrapDaemon({ home: tmp });
    const t0 = Date.now();
    const r = await request(
      { kind: 'hook.continue.request', cwd: '/w', sessionId: 's1', context: 'done' },
      { socketPath: daemonSocketPath(tmp), timeoutMs: 5_000 },
    );
    expect(r).toEqual({ kind: 'hook.continue.result', reply: null });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

// Shared by every describe below that needs a fake IM channel capable of both
// sending/editing cards AND firing a simulated inbound reply (button tap or
// quoted-text reply) back through the daemon's onInbound wiring.
function interactiveAdapter(
  channel: IMChannel,
  sent: OutgoingMessage[],
  edits: Array<{ messageId: string; msg: OutgoingMessage }> = [],
): IMAdapter & { fire: (env: IncomingEnvelope) => void } {
  let handler: ((e: IncomingEnvelope) => void) | undefined;
  return {
    channel,
    async start() { /* noop */ },
    async stop() { /* noop */ },
    async send(out: OutgoingMessage) { sent.push(out); return { messageId: `m${sent.length}` }; },
    async edit(messageId, msg) { edits.push({ messageId, msg }); },
    onInbound(h) { handler = h; },
    isConnected() { return 'connected' as const; },
    fire(env) { handler?.(env); },
  };
}

describe('AskUserQuestion remote card (Task 9)', () => {
  it('sends option buttons (not Allow/Deny) and picking one answers deny+message with the selection', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent);
    expect(sent).toHaveLength(1);
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const ids = card.buttons?.map((b) => b.id) ?? [];
    expect(ids.filter((id) => id.startsWith('ask:')).length).toBe(2); // one per option
    expect(ids.some((id) => id.startsWith('askskip:'))).toBe(true);
    // NB: `toContain` uses ===, not an asymmetric-matcher-aware deep-equal — it
    // would silently accept `expect.stringMatching(...)` and never fail
    // (review Minor 3). `.some(...)` is the real check.
    expect(ids.some((id) => id.startsWith('approve:'))).toBe(false);

    const pickBlue = card.buttons!.find((b) => b.id.endsWith(':1'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: pickBlue.id, ts: 0 });

    const r = await pending as { kind: string; decision?: string; updatedInput?: { answers?: Record<string, string> } };
    expect(r.kind).toBe('hook.permission.result');
    expect(r.decision).toBe('allow'); // allow + updatedInput, not deny+message
    expect(r.updatedInput?.answers?.['Pick a color?']).toBe('Blue');
  });

  it('Skip passes through with an allow decision and no message (local terminal answers)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent);
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const skipBtn = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skipBtn.id, ts: 0 });

    const r = await pending as { kind: string; decision?: string; message?: string };
    expect(r).toEqual({ kind: 'hook.permission.result', decision: 'allow' });
  });

  it('picking an option edits the IM card to "Answered" — the wire is a deny, but the user picked an answer (review Minor 4)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent);
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const pickBlue = card.buttons!.find((b) => b.id.endsWith(':1'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: pickBlue.id, ts: 0 });
    await pending;

    // The settle-edit ("Answered") lands asynchronously relative to the wire
    // reply; on slower transports (Windows named pipes) it can arrive just
    // after `pending` resolves, sometimes behind an intermediate edit. Assert
    // the FINAL edit rather than assuming it's the first/only one (mirrors the
    // multi-select test below).
    await vi.waitFor(() => {
      const t = (edits.at(-1)?.msg as { title?: string })?.title ?? '';
      expect(t).toContain('Answered');
    }, { timeout: 3000, interval: 20 });
    const editedTitle = (edits.at(-1)!.msg as { title?: string }).title ?? '';
    expect(editedTitle).not.toContain('Denied');
  });

  it('fires ONE desktop notification when the approval card goes out (the at-the-computer pointer)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'touch /x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(notes).toHaveLength(1); }); // exactly once — not once per configured channel
    expect(notes[0].title).toContain('Bash');
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
    // Warp-style lifecycle: the answer resolved the LAST pending approval →
    // the desktop notification is actively cleared, never left as a zombie.
    expect(clears.length).toBeGreaterThan(0);
  });

  it('the desktop toast is immediate — it does NOT wait out the IM card grace delay (the local user is the whole point)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 30 }, // IM card held back 30s…
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(notes).toHaveLength(1); });
    expect(sent).toHaveLength(0); // …but the desktop already knows
    // Local answer within grace (PostToolUse cancel) → card never sent, toast cleared.
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await pending;
    expect(clears.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
  });

  it('two configured chats with a slow adapter still get ONE desktop toast render per request (regression: per-chat concurrent pushes each fired a toast)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] }, feishu: { appId: 'a', appSecret: 's', chatId: 'f1' } },
    }));
    const sent: OutgoingMessage[] = [];
    const tg = interactiveAdapter('telegram', sent);
    const fs = interactiveAdapter('feishu', sent);
    // Slow sends: both per-channel pushes are in flight past their await when
    // the first completes — the old post-send sentCards guard let both notify.
    for (const a of [tg, fs]) {
      const base = a.send.bind(a);
      a.send = async (out) => { await new Promise((r) => setTimeout(r, 20)); return base(out); };
    }
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [tg, fs], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'touch /x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(sent).toHaveLength(2); }); // one card per channel…
    expect(notes).toHaveLength(1); // …but a single desktop toast render
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    tg.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
  });

  it('a finished turn does NOT pop a desktop toast (per-turn completion would flood) — it stays on IM only', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { renders.push({ title, body }); }, clear: async () => {} } });
    // Drive the real, shared continueBroker directly (same instance the CC Stop
    // and Codex turn/completed paths both funnel through). Floating request with
    // a tiny window; we only assert the notification surfaces, not the reply.
    void h.continueBroker.request({ cwd: '/w', context: 'Finished building the feature', timeoutSec: 1 });
    await until(() => { expect(sent).toHaveLength(1); }); // …still surfaced on IM
    expect(renders).toHaveLength(0); // no desktop flood on completion…
    expect((sent[0] as { title?: string }).title).toContain('Turn finished');
  });

  it('info-level notify ("Claude is waiting for your input") joins the waiting toast; error-level (failures) does NOT', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { render: async (title, body) => { renders.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    expect(renders).toHaveLength(1);
    expect(renders[0].body).toContain('your input');
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'error', message: 'Bash failed: boom' }, { socketPath: sock, timeoutMs: 2000 });
    expect(renders).toHaveLength(1); // error-level stays on IM/dashboard, never the at-the-keyboard toast
  });

  it('an idle session joins the waiting toast and leaves it when the user types', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const renders: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { render: async (title, body) => { renders.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    clears.length = 0; // discard the daemon's own startup clear (unrelated to this scenario)
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    expect(renders.at(-1)!.title).toContain('your input');
    await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/w', sessionId: 's1', prompt: 'go on' } }, { socketPath: sock, timeoutMs: 2000 });
    expect(clears).toHaveLength(1); // the toast that outlived its cause is now closed
  });

  it('an idle reminder also retires when the session ends, so the resident toast cannot strand', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { render: async () => {}, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    clears.length = 0; // discard the daemon's own startup clear (unrelated to this scenario)
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.event', event: { event: 'session-end', cwd: '/w', sessionId: 's1' } }, { socketPath: sock, timeoutMs: 2000 });
    expect(clears).toHaveLength(1);
  });

  it('an idle reminder is also retired by the session resuming activity at the terminal — but NOT by a background sub-agent\'s', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { render: async () => {}, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    clears.length = 0; // discard the daemon's own startup clear (unrelated to this scenario)
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    // A backgrounded sub-agent's activity is not proof the parent stopped waiting.
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', agentId: 'a-1', toolName: 'Bash', result: {} } }, { socketPath: sock, timeoutMs: 2000 });
    expect(clears).toHaveLength(0);
    // The main session's own activity is.
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Bash', result: {} } }, { socketPath: sock, timeoutMs: 2000 });
    expect(clears).toHaveLength(1);
  });

  it('desktop waiting toast is INDEPENDENT of IM mute (IM ⊥ desktop): /mute on silences IM but the idle toast still fires', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (t, b) => { renders.push({ title: t, body: b }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 }); // /mute on
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    expect(renders).toHaveLength(1); // desktop fires despite the IM mute…
    expect(sent).toHaveLength(0);  // …IM stays silent
  });

  it('a notify for a session the daemon has never seen still carries the "<label> · " tag — first contact must not render before the session is registered', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    // Mirrors a daemon restart: the registry is empty, and this notify is the
    // FIRST thing the daemon ever hears about this session (started earlier).
    expect(h.sessions.get('s-unseen')).toBeUndefined();
    await request(
      { kind: 'hook.notify', cwd: '/unseen-project', sessionId: 's-unseen', level: 'info', message: 'Claude is waiting for your input' },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await waitForSent(sent);
    const msg = sent[0] as { kind: 'text'; text: string };
    expect(msg.text.startsWith('unseen-project · ')).toBe(true);
  });

  it('a pre-existing registry entry (muted, with a pending approval) survives a notify unclobbered', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    h = await bootstrapDaemon({ home: tmp });
    const key = 's-existing';
    h.sessions.upsert({ key, cwd: '/existing-project', pending: { requestId: 'r1', title: 'Old pending', body: 'body' } });
    h.sessions.setMuted(key, true);
    await request(
      { kind: 'hook.notify', cwd: '/existing-project', sessionId: key, level: 'info', message: 'Claude is waiting for your input' },
      { socketPath: daemonSocketPath(tmp), timeoutMs: 2000 },
    );
    expect(h.sessions.get(key)?.muted).toBe(true);
    expect(h.sessions.get(key)?.pending?.requestId).toBe('r1');
  });

  it('the settled card keeps its body — you can still see WHAT was approved (live feedback)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash',
        input: { command: 'touch /tmp/probe', description: 'probe file' },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent);
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const approveBtn = card.buttons!.find((b) => b.id.startsWith('approve:'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: approveBtn.id, ts: 0 });
    await pending;

    expect(edits).toHaveLength(1);
    const edited = edits[0].msg as { title?: string; body?: string; buttons?: unknown[] };
    expect(edited.title).toContain('Allowed');
    expect(edited.body).toContain('touch /tmp/probe');   // the command survives settlement
    expect(edited.buttons ?? []).toHaveLength(0);        // deactivation is button removal, not body erasure
  });

  it('deny-with-guidance writes the reason back onto the settled card', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash',
        input: { command: 'rm -rf /tmp/x' },
        timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent); // let the card go out before referencing its messageId
    const cardMsgId = 'm1'; // interactiveAdapter assigns sequential ids m1, m2, …
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x2', text: 'use mv to the scratchpad instead', replyToMessageId: cardMsgId, ts: 0 });
    const r = await pending as { decision?: string; message?: string };
    expect(r.decision).toBe('deny');

    expect(edits).toHaveLength(1);
    const edited = edits[0].msg as { title?: string; body?: string };
    expect(edited.title).toContain('Denied with guidance');
    expect(edited.body).toContain('rm -rf /tmp/x');                      // original command kept
    expect(edited.body).toContain('> use mv to the scratchpad instead'); // the reason, quoted
  });

  it('malformed AskUserQuestion input falls through to the normal approval card (Allow/Deny)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion', input: { questions: [] }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent);
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const ids = card.buttons?.map((b) => b.id) ?? [];
    expect(ids.some((id) => id.startsWith('approve:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('deny:'))).toBe(true);
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: `deny:${ids[1].split(':')[1]}`, ts: 0 });
    await pending;
  });

  describe('multi-select (Task 10)', () => {
    function multiSelectConfig(): string {
      return JSON.stringify({
        web: { enabled: false },
        approvals: { approvalGraceSec: 0 },
        adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
      });
    }

    function fireMultiSelectRequest(sock: string) {
      return request(
        {
          kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'Pick colors?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }] }] },
          timeoutSec: 60,
        },
        { socketPath: sock, timeoutMs: 10_000 },
      );
    }

    it('sends checkbox/Submit/Skip buttons instead of numbered single-pick buttons', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const adapter = interactiveAdapter('telegram', sent);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      held(pending);
      await waitForSent(sent);
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const ids = card.buttons?.map((b) => b.id) ?? [];
      expect(ids.filter((id) => id.startsWith('asktoggle:')).length).toBe(2); // one per option
      expect(ids.some((id) => id.startsWith('asksubmit:'))).toBe(true);
      expect(ids.some((id) => id.startsWith('askskip:'))).toBe(true);
      expect(ids.some((id) => id.startsWith('ask:'))).toBe(false); // not the single-select numbered form
      const checkboxLabels = card.buttons!.filter((b) => b.id.startsWith('asktoggle:')).map((b) => b.label);
      expect(checkboxLabels).toEqual(['▢ Red', '▢ Blue']);
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;
      expect(submitBtn.label).toBe('Submit (0)');

      const skipBtn = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skipBtn.id, ts: 0 });
      const r = await pending;
      expect(r).toEqual({ kind: 'hook.permission.result', decision: 'allow' });
    });

    it('toggling a checkbox edits the sent card with refreshed state and a live Submit(N) count', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
      const adapter = interactiveAdapter('telegram', sent, edits);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      held(pending);
      await waitForSent(sent);
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const toggleBlue = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':1'))!;

      // Edits now go through the per-rid serial queue (Task 10 review Important
      // fix) — the edit lands on a later microtask, no longer synchronously
      // within fire(), so each assertion needs a tick to let the queue drain.
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleBlue.id, ts: 0 });
      await until(() => { expect(edits).toHaveLength(1); });
      const edited1 = edits[0].msg as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      expect(edited1.buttons!.map((b) => b.label)).toEqual(['▢ Red', '▣ Blue', 'Submit (1)', 'Skip']);

      // toggling the same option again flips it back off
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleBlue.id, ts: 0 });
      await until(() => { expect(edits).toHaveLength(2); });
      const edited2 = edits[1].msg as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      expect(edited2.buttons!.map((b) => b.label)).toEqual(['▢ Red', '▢ Blue', 'Submit (0)', 'Skip']);

      const skipBtn = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skipBtn.id, ts: 0 });
      await pending;
    });

    it('Submit with nothing selected is a no-op — the request stays pending', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const adapter = interactiveAdapter('telegram', sent);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      held(pending);
      await waitForSent(sent);
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const answerSpy = vi.spyOn(h.permissionRouter, 'answer');
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: submitBtn.id, ts: 0 });
      expect(answerSpy).not.toHaveBeenCalled();

      // wrap up so the pending IPC call resolves
      const skipBtn = card.buttons!.find((b) => b.id.startsWith('askskip:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: skipBtn.id, ts: 0 });
      await pending;
    });

    it('toggle-then-submit race: a slow toggle edit landing after the fast settlement edit must not resurrect the checkbox layout (Important bug repro)', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
      // edit() is a real network call in production — nothing guarantees "later
      // dispatched → later landed". Here the toggle edit (carries `buttons`) is
      // deliberately made SLOWER than the settlement edit from onResolved (no
      // `buttons`), reproducing the exact reordering the bug report describes —
      // regardless of which one was actually *dispatched* first.
      let handler: ((e: IncomingEnvelope) => void) | undefined;
      const adapter: IMAdapter & { fire: (env: IncomingEnvelope) => void } = {
        channel: 'telegram',
        async start() { /* noop */ },
        async stop() { /* noop */ },
        async send(out: OutgoingMessage) { sent.push(out); return { messageId: `m${sent.length}` }; },
        async edit(messageId: string, msg: OutgoingMessage) {
          const hasButtons = Boolean((msg as { buttons?: unknown }).buttons);
          await new Promise((r) => setTimeout(r, hasButtons ? 50 : 5));
          edits.push({ messageId, msg });
        },
        onInbound(h) { handler = h; },
        isConnected() { return 'connected' as const; },
        fire(env) { handler?.(env); },
      };
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      held(pending);
      await waitForSent(sent);
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const toggleRed = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':0'))!;
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;

      // Toggle, then Submit — back to back, synchronously, mirroring "quickly
      // tap a checkbox then Submit" from the bug report.
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleRed.id, ts: 0 });
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: submitBtn.id, ts: 0 });

      const r = await pending as { kind: string; decision?: string; message?: string };
      expect(r.decision).toBe('allow'); // ask answer = allow + updatedInput

      // Poll until BOTH artificially-delayed edits have landed AND the card has
      // settled — the LAST edit must be the settlement (from onResolved), never a
      // late toggle edit resurrecting the checkbox layout ("no zombie cards").
      // vi.waitFor holds the invariant deterministically instead of guessing a
      // fixed delay (fragile on slow/jittery Windows named-pipe timing).
      await vi.waitFor(() => {
        expect(edits.length).toBe(2);
        const m = edits.at(-1)!.msg as { title?: string; buttons?: unknown };
        expect(m.title).toContain('Answered');
        expect(m.buttons).toBeUndefined();
      }, { timeout: 3000, interval: 20 });
    });

    it('dual-channel race: a slow channel\'s in-flight toggle loop must not let a fast channel\'s settlement land, then get overwritten by a late toggle edit (multi-channel review Important repro)', async () => {
      // Reproduces the review's multi-channel finding: `asktoggle:`'s edit
      // loop used to `await` each card's queueEdit one at a time. With TWO
      // configured channels (Telegram + Feishu, the onboarding-doc default),
      // a slow channel 1 (telegram) keeps that loop suspended on its own
      // `await` before it ever reaches channel 2 (feishu)'s card. Meanwhile
      // Submit arrives (a SEPARATE inbound message) and onResolved's
      // settlement loop enqueues BOTH channels' settlement edits
      // synchronously, in one tick — including feishu's, which the toggle
      // loop hasn't gotten to yet. Once the toggle loop finally resumes and
      // enqueues feishu's toggle edit, it lands behind the already-enqueued
      // feishu settlement edit → feishu's card reverts to the checkbox
      // layout even though it "answered" first. Fixed by mirroring
      // onResolved's own pattern: enqueue every card's edit synchronously,
      // no per-card await.
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({
        web: { enabled: false },
        approvals: { approvalGraceSec: 0 },
        adapters: {
          telegram: { token: 't', chatIdAllowList: ['c1'] },
          feishu: { appId: 'a', appSecret: 's', chatId: 'c2' },
        },
      }));
      function delayedChannelAdapter(
        channel: IMChannel,
        delayMs: number,
        sent: OutgoingMessage[],
        edits: Array<{ channel: IMChannel; messageId: string; msg: OutgoingMessage }>,
      ): IMAdapter & { fire: (env: IncomingEnvelope) => void } {
        let handler: ((e: IncomingEnvelope) => void) | undefined;
        return {
          channel,
          async start() { /* noop */ },
          async stop() { /* noop */ },
          async send(out: OutgoingMessage) { sent.push(out); return { messageId: `${channel}-m${sent.length}` }; },
          async edit(messageId: string, msg: OutgoingMessage) {
            await new Promise((r) => setTimeout(r, delayMs));
            edits.push({ channel, messageId, msg });
          },
          onInbound(h) { handler = h; },
          isConnected() { return 'connected' as const; },
          fire(env) { handler?.(env); },
        };
      }
      const sentTg: OutgoingMessage[] = [];
      const sentFs: OutgoingMessage[] = [];
      const edits: Array<{ channel: IMChannel; messageId: string; msg: OutgoingMessage }> = [];
      const tg = delayedChannelAdapter('telegram', 80, sentTg, edits); // channel 1: slow
      const fs = delayedChannelAdapter('feishu', 5, sentFs, edits); // channel 2: fast
      h = await bootstrapDaemon({ home: tmp, imAdapters: [tg, fs] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      held(pending);
      await waitForSent(sentTg);
      await waitForSent(sentFs);
      expect(sentTg).toHaveLength(1);
      expect(sentFs).toHaveLength(1);
      const card = sentTg[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const toggleRed = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':0'))!;
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;

      // Tap a checkbox then Submit, back to back on the SAME chat client
      // (telegram) — mirrors real usage: the user only ever interacts via
      // one channel, but both channels' cards must still settle correctly.
      tg.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleRed.id, ts: 0 });
      tg.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: submitBtn.id, ts: 0 });

      const r = await pending as { kind: string; decision?: string };
      expect(r.decision).toBe('allow'); // ask answer = allow + updatedInput

      // Poll until feishu's card has settled — its LAST edit must be the
      // settlement/Answered state, not reverted to the checkbox layout by a late
      // toggle edit ("no zombie cards"). Deterministic vs a fixed delay.
      await vi.waitFor(() => {
        const fsEdits = edits.filter((e) => e.channel === 'feishu');
        const m = fsEdits.at(-1)?.msg as { title?: string; buttons?: unknown } | undefined;
        expect(m?.title).toContain('Answered');
        expect(m?.buttons).toBeUndefined();
      }, { timeout: 3000, interval: 20 });
    });

    it('Submit with picks answers deny+message carrying every selected label, and edits the card to Answered', async () => {
      writeFileSync(join(tmp, 'config.json'), multiSelectConfig());
      const sent: OutgoingMessage[] = [];
      const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
      const adapter = interactiveAdapter('telegram', sent, edits);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
      const sock = daemonSocketPath(tmp);
      const pending = fireMultiSelectRequest(sock);
      held(pending);
      await waitForSent(sent);
      const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
      const toggleRed = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':0'))!;
      const toggleBlue = card.buttons!.find((b) => b.id.startsWith('asktoggle:') && b.id.endsWith(':1'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleRed.id, ts: 0 });
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: toggleBlue.id, ts: 0 });
      const submitBtn = card.buttons!.find((b) => b.id.startsWith('asksubmit:'))!;
      adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: submitBtn.id, ts: 0 });

      const r = await pending as { kind: string; decision?: string; updatedInput?: { answers?: Record<string, string> } };
      expect(r.decision).toBe('allow'); // allow + updatedInput, not deny+message
      expect(r.updatedInput?.answers?.['Pick colors?']).toBe('Red, Blue');

      const lastEdit = edits.at(-1)!;
      const title = (lastEdit.msg as { title?: string }).title ?? '';
      expect(title).toContain('Answered');
      expect(title).not.toContain('Denied');
    });
  });
});

describe('quoting a live approval card = deny with guidance (Task 7)', () => {
  it('routes the quoted reply to the pending permission request as a deny+message, and rewrites the card "Denied with guidance"', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent);
    expect(sent).toHaveLength(1); // sanity: the card really was sent, its messageId is `m1`
    adapter.fire({
      channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1',
      replyToMessageId: 'm1', text: 'Do not use rm -rf, move it to /tmp/.trash instead', ts: 0,
    });

    const r = await pending as { kind: string; decision?: string; message?: string };
    expect(r.decision).toBe('deny');
    expect(r.message).toBe('Do not use rm -rf, move it to /tmp/.trash instead');

    await until(() => { expect(edits).toHaveLength(1); }); // let the queued settlement edit land
    const editedTitle = (edits[0].msg as { title?: string }).title ?? '';
    expect(editedTitle).toContain('Denied with guidance');
  });

  it('a plain button Deny (no quoted text) still edits the card to the bare "Denied" — guidance label only when a message rode along', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent);
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const denyBtn = card.buttons!.find((b) => b.id.startsWith('deny:'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: denyBtn.id, ts: 0 });
    await pending;

    await until(() => { expect(edits).toHaveLength(1); });
    const editedTitle = (edits[0].msg as { title?: string }).title ?? '';
    expect(editedTitle).toContain('Denied');
    expect(editedTitle).not.toContain('Denied with guidance');
  });

  // Mirrors the hook.notify first-contact fix above, one call site over:
  // onPending's board entry also renders sessionLabel(key) — and used to do so
  // BEFORE its own final `sessions.upsert(...)` registered the session, so a
  // session's very first tool-permission request (e.g. right after a daemon
  // restart) produced an unlabelled toast.
  it('the first-ever permission request for a never-before-seen session still carries the "<label> · " toast prefix (onPending)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);
    // Mirrors a daemon restart: the registry is empty before this request.
    expect(h.sessions.get('s-fresh')).toBeUndefined();
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/fresh-project', sessionId: 's-fresh', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(notes).toHaveLength(1); });
    expect(notes[0].title.startsWith('fresh-project · ')).toBe(true);
  });
});

// Regression: the Codex resume path (makeCodexResumeHandler → ContinueBroker →
// continueBroker.onRequest wired in bootstrapDaemon) used to default the
// continue-request `context` to the bare string 'Turn finished', while the
// card-body-emptying check in bootstrap.ts compared against the longer
// 'Turn finished — reply to continue' sentinel that only the CC (normalizer.ts
// stop event) path actually produces. The two hardcoded literals drifted, so
// on Codex with no lastMessage the emptying check never matched and the card
// body quoted 'Turn finished' right under a 'Turn finished' title.
describe('Codex resume handler → continue card (regression: sentinel mismatch)', () => {
  function recordingAdapter(channel: IMChannel, sent: OutgoingMessage[]): IMAdapter {
    return {
      channel,
      async start() { /* noop */ },
      async stop() { /* noop */ },
      async send(out: OutgoingMessage) { sent.push(out); return { messageId: 'm1' }; },
      async edit() { /* noop */ },
      onInbound(_h: (e: IncomingEnvelope) => void) { /* noop */ },
      isConnected() { return 'connected' as const; },
    };
  }

  it('renders an empty continue-card body (no duplicated title) when Codex has no lastMessage', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [recordingAdapter('telegram', sent)] });

    // Mirrors exactly how bootstrapDaemon wires makeCodexResumeHandler: same
    // (real, shared) continueBroker instance whose onRequest handler is the
    // one that builds the IM card.
    const onCodexResumePrompt = makeCodexResumeHandler({
      broker: h.continueBroker,
      sessions: h.sessions,
      events: h.events,
      chats: () => [{}], // non-empty → bypasses the fast-null path
      resume: async () => undefined,
    });

    onCodexResumePrompt({ threadId: 't1', key: 'codex:t1' }); // no lastMessage
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(sent).toHaveLength(1);
    const card = sent[0] as { kind: 'card'; title?: string; body?: string };
    // Title carries the usual `<label> · ` session tag (unrelated to this bug);
    // what matters here is that the body is NOT a quoted repeat of the title.
    expect(card.title?.endsWith('Turn finished')).toBe(true);
    expect(card.body).toBe('\n*Reply to this message to continue.*');
  });
});

// A sub-agent's request is handed straight back to CC so its terminal dialog
// appears undelayed — but tlive holds the full request in its hands at that
// moment (tool name, whole input, agentId) and used to throw all of it away. The
// only thing the user then got was CC's own permission_prompt notification, which
// carries no tool name and no agentId, so it could say nothing useful and could
// not be attributed; full mode suppresses it for that reason. Result: a blocked
// sub-agent was invisible. Push what we already know instead.
//
// No Allow/Deny buttons: that dialog can only be answered at the keyboard (CC
// awaits the hook before building it, so the hook invocation is over by the time
// the dialog exists). Buttons that cannot work are worse than none.
describe('sub-agent pass-through tells you what is blocked', () => {
  const CFG = {
    mode: 'full',
    web: { enabled: false },
    approvals: { approvalGraceSec: 0 },
    adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
  };

  it('pushes the tool and its input, without answer buttons', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);

    const r = await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    // Handed back untouched — the terminal dialog must not be delayed.
    expect(r).toEqual({ kind: 'hook.permission.result', decision: 'defer' });

    await waitForSent(sent);
    const msg = sent[0] as { kind: string; title?: string; body?: string; text?: string; buttons?: Array<{ id: string }> };
    const shown = `${msg.title ?? ''}\n${msg.body ?? ''}\n${msg.text ?? ''}`;
    expect(shown).toContain('Bash');                    // what tool
    expect(shown).toContain('rm -rf /tmp/scratch');      // and what it wants to do
    // Nothing that pretends to be answerable from here.
    const ids = (msg.buttons ?? []).map((b) => b.id);
    expect(ids.filter((id) => id.startsWith('approve:') || id.startsWith('deny:'))).toEqual([]);
  });

  // The notice has to retire itself, or it becomes a card that still says
  // "waiting" long after the thing was answered. (agentId, toolName) is what
  // makes that possible: measured on a live session, the sub-agent's PostToolUse
  // comes back carrying the SAME pair the pass-through carried, so the two ends
  // can be matched. Note the notification path could never do this — CC's
  // permission_prompt has no agentId at all.
  it('retires the notice once that sub-agent tool actually runs', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await waitForSent(sent);

    // The answer happened at the keyboard; the tool then ran, which is the only
    // thing tlive ever learns about the outcome.
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );

    await until(() => { expect(edits.length).toBeGreaterThanOrEqual(1); });
    expect(JSON.stringify(edits[0].msg)).toMatch(/ran at the terminal/i);
  });

  // Cards must not lie: the title says the tool RAN, so the body must not
  // still say it is WAITING to be answered (real Telegram screenshot — the
  // retirement edit used to reuse the exact same body text, waiting sentence
  // included). The tool/input content must survive the edit though — that's
  // the whole point of keeping the body at all, so you can look back and see
  // what ran.
  it('the retirement edit body does not still say "waiting" once the title says the tool ran', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await waitForSent(sent);

    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await until(() => { expect(edits.length).toBeGreaterThanOrEqual(1); });

    const card = edits[0].msg as { title?: string; body?: string };
    expect(card.title).toContain('Bash'); // "<tool> · sub-agent · ran at the terminal"
    expect(card.title).toContain('ran at the terminal');
    expect(card.body).not.toContain('Waiting at the terminal');
    // the tool content survives the edit — that's the point of keeping body at all.
    expect(card.body).toContain('rm -rf /tmp/scratch');
  });

  it('leaves the notice alone when a DIFFERENT sub-agent runs the same tool', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await waitForSent(sent);

    // A sibling sub-agent's Bash. Parallel sub-agents share key + toolName, so
    // ignoring agentId here would retire the wrong notice.
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', agentId: 'a-99', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(edits).toEqual([]);
  });

  async function findSession(sock: string, id: string) {
    const r = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
    if (r.kind !== 'session.list') throw new Error('bad reply');
    return r.sessions.find((s) => s.id === id);
  }

  // The IM notice (above) is only half the gap: with no IM configured, or
  // `/mute` on, or the user simply not looking at their phone, a blocked
  // sub-agent used to produce NO signal at all. The desktop toast is
  // precisely the "at this machine, not watching the terminal" channel.
  it('fires ONE desktop toast render naming the tool when a sub-agent request passes through', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );

    await until(() => { expect(notes).toHaveLength(1); });
    expect(notes[0].title).toContain('Bash');
    expect(notes[0].title).toContain('sub-agent');
    expect(notes[0].body).toContain('Waiting at the terminal');
  });

  // Same call-site-ordering bug as onPending above, the other flagged site:
  // onPassthrough's board entry also renders sessionLabel(key) before its own
  // guarded upsert registered the session, so a sub-agent's first-ever
  // pass-through (e.g. right after a daemon restart) produced an unlabelled toast.
  it('a sub-agent pass-through for a never-before-seen session still carries the "<label> · " toast prefix', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);
    expect(h.sessions.get('s1')).toBeUndefined();

    await request(
      {
        kind: 'hook.permission.request', cwd: '/fresh-subagent-project', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );

    await until(() => { expect(notes).toHaveLength(1); });
    expect(notes[0].title.startsWith('fresh-subagent-project · ')).toBe(true);
  });

  // The waiting sentence uses *italic* (telegram-html.ts's supported emphasis),
  // NOT _italic_ — the renderer deliberately does not support underscore
  // emphasis (ordinary snake_case/file_path content would turn italic), so the
  // raw underscores used to leak into the message verbatim (real Telegram
  // screenshot). Runs the actual live notice body through the real converter
  // rather than asserting on the raw source string, so this cannot regress
  // silently if the sentence is ever reworded.
  it('the live notice body renders to <i>…</i> through the Telegram converter — no stray underscore reaches the user', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await waitForSent(sent);
    const card = sent[0] as { kind: 'card'; body?: string };
    const html = mdToTelegramHtml(card.body ?? '');
    expect(html).toContain('<i>');
    expect(html).not.toContain('_');
  });

  // IM ⊥ desktop: `/mute` is an IM-only switch. The old early-return at the
  // top of onPassthrough killed the WHOLE announcement on mute, which broke
  // that rule for this notice specifically.
  it('IM mute silences the card, but the desktop toast still fires (IM ⊥ desktop)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 }); // /mute on

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );

    await until(() => { expect(notes).toHaveLength(1); }); // desktop unaffected by IM mute…
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toHaveLength(0); // …but the IM card never went out
  });

  // C1: a sub-agent pass-through creates no router pending at all
  // (requestPermission returns {decision:'defer'} immediately for it), so
  // unlike a `held` entry there is no cancel/timeout/onResolved for it —
  // retirePassthruNotice, reached only from a MATCHING PostToolUse
  // (agentId+toolName), used to be the ONLY way off the board. Deny the
  // dialog (or Esc it, or let the sub-agent abort) and no PostToolUse ever
  // arrives, so the entry — and with it board.isEmpty(), so `clear()` for
  // every OTHER session too — was stuck for the daemon's remaining lifetime.
  // These three tests drive the eager fallbacks added for it.
  describe('a pass-through notice retires even when the exact PostToolUse match never arrives (C1)', () => {
    it('permission-denied retires it — a denied dialog never runs, so it never runs a matching PostToolUse', async () => {
      writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
      const sent: OutgoingMessage[] = [];
      const adapter = interactiveAdapter('telegram', sent);
      const notes: Array<{ title: string; body: string }> = [];
      const clears: number[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
      const sock = daemonSocketPath(tmp);
      clears.length = 0; // discard the daemon's own startup clear

      await request(
        { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60 },
        { socketPath: sock, timeoutMs: 5000 },
      );
      await until(() => { expect(notes).toHaveLength(1); });

      // No agentId is available on this event at all (CC's PermissionDenied
      // hook never carries one) — the match can only be key + toolName.
      await request(
        { kind: 'hook.event', event: { event: 'permission-denied', cwd: '/w', sessionId: 's1', toolName: 'Bash' } },
        { socketPath: sock, timeoutMs: 2000 },
      );
      await until(() => { expect(clears.length).toBeGreaterThan(0); });
    });

    it('a fresh prompt at the terminal retires it — the session moved on, so any notice still on the board is stale', async () => {
      writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
      const sent: OutgoingMessage[] = [];
      const adapter = interactiveAdapter('telegram', sent);
      const notes: Array<{ title: string; body: string }> = [];
      const clears: number[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
      const sock = daemonSocketPath(tmp);
      clears.length = 0;

      await request(
        { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60 },
        { socketPath: sock, timeoutMs: 5000 },
      );
      await until(() => { expect(notes).toHaveLength(1); });

      await request(
        { kind: 'hook.event', event: { event: 'prompt', cwd: '/w', sessionId: 's1', prompt: 'go on' } },
        { socketPath: sock, timeoutMs: 2000 },
      );
      await until(() => { expect(clears.length).toBeGreaterThan(0); });
    });

    it('the session ending retires it — a dead session cannot still be waiting on anything', async () => {
      writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
      const sent: OutgoingMessage[] = [];
      const adapter = interactiveAdapter('telegram', sent);
      const notes: Array<{ title: string; body: string }> = [];
      const clears: number[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
      const sock = daemonSocketPath(tmp);
      clears.length = 0;

      await request(
        { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60 },
        { socketPath: sock, timeoutMs: 5000 },
      );
      await until(() => { expect(notes).toHaveLength(1); });

      await request(
        { kind: 'hook.event', event: { event: 'session-end', cwd: '/w', sessionId: 's1' } },
        { socketPath: sock, timeoutMs: 2000 },
      );
      await until(() => { expect(clears.length).toBeGreaterThan(0); });
    });
  });

  // Reuses the same read-only shape as the notify-mode local-prompt card
  // (`local: true`) — there is no held request behind it, so Allow/Deny would
  // be a button that cannot work. The registry holds ONE pending slot per
  // session key, so a sub-agent notice must never evict an already-held
  // main-session approval.
  it('upserts a read-only dashboard card, but never evicts an already-held main-session approval', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);

    // Fresh session, nothing held — the pass-through alone creates the card.
    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    const s1 = await findSession(sock, 's1');
    expect(s1?.pending?.local).toBe(true);
    expect(s1?.pending?.title).toContain('sub-agent');
    expect(s1?.pending?.requestId).toContain('a-77');

    // A held MAIN-session approval (no agentId) already owns 's2' — a
    // sub-agent notice for the SAME key must not steal the pending slot.
    const heldMain = held(request(
      { kind: 'hook.permission.request', cwd: '/w2', sessionId: 's2', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    ));
    await waitForSent(sent);
    const before = await findSession(sock, 's2');
    const heldRequestId = before?.pending?.requestId;
    expect(heldRequestId).toBeTruthy();
    expect(before?.pending?.local).toBeUndefined(); // the answerable card

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w2', sessionId: 's2', agentId: 'a-88',
        toolName: 'Read', input: { file_path: '/etc/hosts' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    const after = await findSession(sock, 's2');
    expect(after?.pending?.requestId).toBe(heldRequestId); // untouched — never overwritten
    void heldMain; // resolved by the daemon's own shutdown() → settleAllPending
  });

  // Retirement (measured live: the sub-agent's PostToolUse carrying the same
  // (agentId, toolName) pair) must close BOTH the dashboard card and the
  // desktop toast when nothing else is waiting — and must not close the toast
  // early when a held approval elsewhere is still pending, since the toast is
  // one shared machine-wide slot.
  it('a matching PostToolUse clears the dashboard card and closes the toast — but not while a held approval is still pending', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);

    // Nothing else pending: retirement closes both surfaces.
    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await until(() => { expect(notes).toHaveLength(1); });
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await until(() => { expect(clears.length).toBeGreaterThan(0); });
    expect((await findSession(sock, 's1'))?.pending).toBeUndefined();

    // A held main-session approval on a DIFFERENT session is still
    // outstanding when THIS session's sub-agent notice retires.
    const heldMain = held(request(
      { kind: 'hook.permission.request', cwd: '/w2', sessionId: 's2', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    ));
    await until(() => { expect(notes.length).toBeGreaterThanOrEqual(2); });
    clears.length = 0;

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w3', sessionId: 's3', agentId: 'a-99',
        toolName: 'Read', input: { file_path: '/etc/hosts' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await until(() => { expect(notes.length).toBeGreaterThanOrEqual(3); });
    expect((await findSession(sock, 's3'))?.pending?.local).toBe(true);

    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w3', sessionId: 's3', agentId: 'a-99', toolName: 'Read', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(clears).toEqual([]); // s2's held approval still pending → toast stays open
    expect((await findSession(sock, 's3'))?.pending).toBeUndefined(); // s3's own card still retires
    void heldMain; // resolved by the daemon's own shutdown() → settleAllPending
  });

  // Regression: the desktop-clear condition must be ONE predicate evaluated
  // identically everywhere — not three separate copies. A copy that forgets
  // passthruWaiting closes a still-outstanding sub-agent toast the INSTANT
  // something else the daemon tracks resolves, anywhere. This drives that
  // through onResolved specifically: s2's resolution must NOT touch s1's
  // still-outstanding sub-agent dialog. It then retires s1 via
  // permission-denied rather than a matching PostToolUse — the dialog was
  // DENIED, not run, so it never fires one, and retirePassthruNotice's exact
  // (agentId, toolName) match never gets a chance to run at all (this used to
  // strand the entry, and with it board.isEmpty(), for the daemon's remaining
  // lifetime — C1).
  it("a held approval resolving on ANOTHER session must not close the toast while a sub-agent pass-through is still outstanding (onResolved)", async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    clears.length = 0; // discard the daemon's own startup clear (stray-toast retraction, unrelated to this scenario)

    // s1: sub-agent pass-through — still outstanding for the rest of this test.
    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await until(() => { expect(notes).toHaveLength(1); });

    // s2: a genuine held MAIN-session approval, answered via IM → onResolved fires.
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w2', sessionId: 's2', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    // sent[] also carries s1's pass-through IM notice (its own "mode:all"
    // button) — find the actual approvable card, not just sent[0].
    await vi.waitFor(() => {
      expect((sent as Array<{ buttons?: Array<{ id: string }> }>).some((m) => m.buttons?.some((b) => b.id.startsWith('approve:')))).toBe(true);
    }, { timeout: 3000, interval: 10 });
    const card = (sent as Array<{ buttons?: Array<{ id: string; label: string }> }>).find((m) => m.buttons?.some((b) => b.id.startsWith('approve:')))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;

    // s2's own approval just resolved — s1's sub-agent dialog is still
    // unanswered at the terminal, so the toast must NOT have closed.
    expect(clears).toEqual([]);

    // Only once s1's notice actually retires does the toast close — here via
    // permission-denied (denied at the terminal, not run), the eager
    // key+toolName fallback added for C1, since a denial never runs the
    // sub-agent's tool and so never reaches retirePassthruNotice.
    await request(
      { kind: 'hook.event', event: { event: 'permission-denied', cwd: '/w', sessionId: 's1', toolName: 'Bash' } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await until(() => { expect(clears.length).toBeGreaterThan(0); });
  });

  // Mirrors the test above for the OTHER pre-existing copy of the condition:
  // clearLocalPrompt (the notify-mode / full-mode-defer CC-native dialog
  // tracker) must not close the toast either, while a sub-agent pass-through
  // elsewhere is still outstanding. mode: 'notify' is required to get a
  // tracked local prompt at all — 'full' treats permission_prompt as
  // redundant and never calls localPrompts.note in the first place.
  it('clearing a local prompt on ANOTHER session must not close the toast while a sub-agent pass-through is still outstanding (clearLocalPrompt)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);
    clears.length = 0; // discard the daemon's own startup clear (stray-toast retraction, unrelated to this scenario)

    // s1: sub-agent pass-through — still outstanding for the rest of this test.
    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await until(() => { expect(notes).toHaveLength(1); });

    // s2: a notify-mode CC-native dialog (no held request), tracked…
    await request(
      { kind: 'hook.notify', cwd: '/w2', sessionId: 's2', level: 'info', message: 'Claude needs your permission to use Bash', permissionPrompt: true },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await until(() => { expect(notes.length).toBeGreaterThanOrEqual(2); });

    // …then answered at the keyboard → clearLocalPrompt fires.
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w2', sessionId: 's2', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    // s1's sub-agent dialog is still unanswered — the toast must NOT have closed.
    expect(clears).toEqual([]);

    // Only once s1's notice actually retires does the toast close.
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await until(() => { expect(clears.length).toBeGreaterThan(0); });
  });
});

// Telegram caps callback_data at 64 BYTES and rejects the ENTIRE sendMessage
// (BUTTON_DATA_INVALID) when any button exceeds it. `allowtool:<uuid>:<toolName>`
// spends 47 bytes before the name, so any tool named longer than 17 characters
// used to take the whole approval card down with it — and permission-router
// swallows send failures, so the request simply hung with no answer surface and
// nothing in the log. MCP tools (`mcp__<server>__<tool>`) are always over.
describe('approval card button ids fit the IM callback-data limit', () => {
  const CALLBACK_DATA_MAX_BYTES = 64;
  const CFG = {
    web: { enabled: false },
    approvals: { approvalGraceSec: 0 },
    adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
  };

  it('holds for a long MCP tool name without producing an unsendable button', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1',
        toolName: 'mcp__codegraph__codegraph_status', input: {}, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent);
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const tooLong = (card.buttons ?? [])
      .filter((b) => Buffer.byteLength(b.id, 'utf8') > CALLBACK_DATA_MAX_BYTES)
      .map((b) => `${b.id} (${Buffer.byteLength(b.id, 'utf8')}B)`);
    expect(tooLong).toEqual([]);
    // The label still names the tool — only the callback payload is trimmed.
    expect(card.buttons?.some((b) => b.label.includes('mcp__codegraph__codegraph_status'))).toBe(true);
  });
});

// PermissionRequest fires only when CC is about to show a dialog, so an
// auto-allow here deletes a prompt the user would have seen. That must be opt-in.
describe('read-only auto-allow wiring', () => {
  const REQ = { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Read', input: { file_path: '/etc/hosts' }, timeoutSec: 60 } as const;

  it('default config does not auto-allow Read — it falls back to CC (defer)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    h = await bootstrapDaemon({ home: tmp });
    const r = await request(REQ, { socketPath: daemonSocketPath(tmp), timeoutMs: 5000 });
    expect(r).toEqual({ kind: 'hook.permission.result', decision: 'defer' });
  });

  it("approvals.autoApprove 'readonly' opts back in", async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { autoApprove: 'readonly' } }));
    h = await bootstrapDaemon({ home: tmp });
    const r = await request(REQ, { socketPath: daemonSocketPath(tmp), timeoutMs: 5000 });
    expect(r).toEqual({ kind: 'hook.permission.result', decision: 'allow' });
  });
});

describe('permission_prompt forwarding — the notify-mode / immediate-defer notification chain, now with no more dead mail to IM (issue #49)', () => {
  const CFG = {
    web: { enabled: false },
    approvals: { approvalGraceSec: 0 },
    adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
  };
  const MSG = 'Claude needs your permission to use Bash';

  async function findSession(sock: string, id: string) {
    const r = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
    if (r.kind !== 'session.list') throw new Error('bad reply');
    return r.sessions.find((s) => s.id === id);
  }

  it('no held request → desktop toast + read-only waiting-approval card; IM gets the one-time notify explanation, not dead mail (the chain a silent hang used to be)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    // Desktop: the waiting slot (board-driven render), speaking to the person
    // at the machine. Single-entry wording is "<label> · <what>" / the
    // WaitingBoard localPrompt body (see waiting-board.ts's BODY table).
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('permission');
    expect(notes[0].body).toContain('answer it there');
    // Dashboard: read-only pending — waiting-approval, marked local.
    const s = await findSession(sock, 's1');
    expect(s?.status).toBe('waiting-approval');
    expect(s?.pending?.local).toBe(true);
    expect(s?.pending?.body).toBe(MSG);
    // IM: no dead-mail text — this dialog can only be answered at the
    // terminal. The first-ever prompt for this chat instead gets the
    // one-time explanation card, with a one-tap switch to `full`.
    await waitForSent(sent);
    expect(sent[0]).toMatchObject({ kind: 'card' });
    const card = sent[0] as { title?: string; buttons?: Array<{ id: string }> };
    expect(card.title).toContain('Approvals stay at your terminal');
    expect(card.buttons?.map((b) => b.id)).toContain('mode:full');
  });

  // In `full` mode every request tlive sees ends up either held (an answerable
  // card owns every surface) or deliberately handed back. So a permission_prompt
  // arriving with nothing held means tlive handed that one back — and for the
  // only case that produces a dialog, a sub-agent pass-through, tlive has already
  // pushed a notice naming the tool and its input. This event adds nothing: it
  // carries no tool_name and no agent_id, so it cannot even say which dialog it
  // means.
  //
  // Building the chain from it anyway is what produced a card that never went
  // away: retiring it needs the answer, and the only signal tlive gets is the
  // sub-agent's PostToolUse, which is skipped here precisely because it carries an
  // agentId (a sibling's activity must not retire the main session's reminder).
  // Measured live: a workflow session sat at `status: active` with a "Permission
  // needed" card still on it, because every event in that session was a
  // sub-agent's. Don't create it, and there is nothing to retire.
  it('full mode: a permission_prompt with nothing held creates no card, toast or IM text', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'full' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    await new Promise((r) => setTimeout(r, 80));
    expect(notes).toEqual([]);
    expect((await findSession(sock, 's1'))?.pending ?? null).toBeNull();
    expect(sent).toHaveLength(0);
  });

  // Mirrors the 'full mode' test above for the top rung: 'all' is ALSO a
  // holding posture (every request tlive saw was held or handed back), so it
  // must behave identically. Before the fix, `redundant` was computed from
  // `mode === 'full'` alone, so 'all' fell through as `redundant = false` and
  // built the chain anyway in a posture where it must not run (see the
  // comment above `redundant` in bootstrap.ts).
  it('all mode: a permission_prompt with nothing held ALSO creates no card, toast or IM text', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'all' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    await new Promise((r) => setTimeout(r, 80));
    expect(notes).toEqual([]);
    expect((await findSession(sock, 's1'))?.pending ?? null).toBeNull();
    expect(sent).toHaveLength(0);
  });

  // The regression this describe block exists to guard against: the posture is
  // remotely settable (`tlive mode`, IM's `/mode`) and must never be cached at
  // boot. Boot in `full`, then flip to `notify` — exactly "tap `notify` on the
  // ladder card while a boot-time-`full` daemon is still running" — and this
  // chain must run per the CURRENT posture, not the boot one. The old
  // `const mode = effectiveMode(cfg.mode)` (read once at boot) would have left
  // `redundant` stuck `true` here, silently re-opening issue #49.
  it('a posture change made AFTER boot changes whether this chain runs — not the boot-time posture', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'full' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    writeMode(tmp, 'notify');

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    // Now on 'notify' — the chain must run: it is the only signal a dialog is
    // waiting. IM gets no dead-mail text; the first-ever prompt for this chat
    // gets the one-time explanation card instead.
    expect(notes).toHaveLength(1);
    expect((await findSession(sock, 's1'))?.pending?.local).toBe(true);
    await waitForSent(sent);
    expect(sent[0]).toMatchObject({ kind: 'card' });
    const card = sent[0] as { buttons?: Array<{ id: string }> };
    expect(card.buttons?.map((b) => b.id)).toContain('mode:full');
  });

  it('notify mode sends NO IM text for a terminal-only dialog — you cannot answer it from a phone', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async () => {}, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w/api', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((m) => (m as { text?: string }).text?.includes('answer in the terminal'))).toHaveLength(0);
  });

  it('the first suppressed dialog explains itself once per chat, with a way out', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async () => {}, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w/api', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await waitForSent(sent);
    expect(sent).toHaveLength(1);
    const card = sent[0] as { buttons?: Array<{ id: string }> };
    expect(card.buttons?.map((b) => b.id)).toContain('mode:full');

    // A second, unrelated session hits the same suppressed-dialog path —
    // same chat, so the explanation must not repeat.
    await request({ kind: 'hook.notify', cwd: '/w/api2', sessionId: 's2', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1); // said once, never again
  });

  // I4: markNotifyExplained fires BEFORE the send resolves (mark-before-send,
  // deliberate — see the comment above it in bootstrap.ts), so a delivery
  // failure right there burns the one lifetime card without it ever reaching
  // the user. That must not vanish into a bare `.catch(() => undefined)` —
  // this is exactly the "IM never fires, it must be broken" state the card
  // exists to prevent, so the failure has to be at least visible in the log.
  it('a failed send of the one-time explain card is logged, not silently swallowed', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    adapter.send = async () => { throw new Error('boom: telegram 5xx'); };
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async () => {}, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w/api', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await vi.waitFor(() => {
      expect(logs.some((l) => l.includes('permission.localPrompt.im.undelivered'))).toBe(true);
    }, { timeout: 2000, interval: 10 });
    const entry = JSON.parse(logs.find((l) => l.includes('permission.localPrompt.im.undelivered'))!) as { error?: string };
    expect(entry.error).toContain('boom');
    logSpy.mockRestore();

    // The flag is still burned even though delivery failed — mark-before-send
    // means a retry (e.g. unmuting later) is a NEW state, not a resend of this
    // same failed attempt (a second dialog for the same chat stays quiet).
    await request({ kind: 'hook.notify', cwd: '/w/api2', sessionId: 's2', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.filter((l) => l.includes('permission.localPrompt.im.undelivered'))).toHaveLength(1);
  });

  it('the explanation survives a daemon restart — "once" means once, not once per boot', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const boot = async (): Promise<void> => {
      const adapter = interactiveAdapter('telegram', sent);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async () => {}, clear: async () => {} } });
      await request({ kind: 'hook.notify', cwd: '/w/api', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: daemonSocketPath(tmp), timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, 50));
      await h.shutdown();
    };
    await boot();
    await boot();
    expect(sent).toHaveLength(1);
  });

  it('an idle session still reaches IM — replying there continues the run, so it is not dead mail', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async () => {}, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w/vf', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(sent.some((m) => (m as { text?: string }).text?.includes('waiting for your input'))).toBe(true); });
  });

  it('a held request for the same session already owns every surface → the notification is dropped (full-mode dedupe)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent); // card out ⇒ pending registered, onPending ping fired
    expect(notes).toHaveLength(1);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(1); // no second toast
    expect(sent).toHaveLength(1); // no extra IM text — the card owns IM
    const s = await findSession(sock, 's1');
    expect(s?.pending?.local).toBeUndefined(); // still the answerable card
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
  });

  // The IM text this test's name used to protect is gone (dead mail). What
  // survives: a local answer still retires the tracked dialog (pending gone,
  // toast closed) — and the one-time explain card, which fires immediately
  // rather than riding any grace, is unaffected by that retirement (it isn't
  // per-dialog, so there's nothing for the local answer to cancel).
  it('a local answer (main-session PostToolUse) retires the chain: pending gone, toast closed — the one-time explain card is unaffected (it fires immediately, not gated by grace)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, approvals: { approvalGraceSec: 30 } }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async () => {}, clear: async () => { clears.push(1); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    expect((await findSession(sock, 's1'))?.status).toBe('waiting-approval');
    await waitForSent(sent); // the one-time explanation card, sent immediately
    expect(sent).toHaveLength(1);

    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Bash', result: {} } }, { socketPath: sock, timeoutMs: 2000 });

    const s = await findSession(sock, 's1');
    expect(s?.status).toBe('active');
    expect(s?.pending).toBeUndefined();
    expect(clears.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1); // still just the one explanation — nothing new fires on retire
  });

  it('sub-agent activity does NOT retire the main-session dialog tracking (parallel agents keep running while you look at the dialog)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async () => {}, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Read', result: {}, agentId: 'agentA' } }, { socketPath: sock, timeoutMs: 2000 });

    const s = await findSession(sock, 's1');
    expect(s?.pending?.local).toBe(true); // still waiting — only a MAIN-session answer clears it
  });

  // /mute is a promise to suppress outbound IM (docs: "mute IM notifications
  // ONLY"), and the explanation card's own rationale — silence might read as
  // breakage — does not apply to someone who deliberately caused the
  // silence; for them the card would read as a mute bypass carrying a
  // call-to-action. So it stays mute-gated same as every other IM push.
  // Desktop + dashboard are unaffected by `/mute` either way (IM ⊥ desktop).
  it('muted IM gets no explanation card; desktop + dashboard still fire (IM ⊥ desktop)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async (title, body) => { notes.push({ title, body }); }, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(1);
    expect((await findSession(sock, 's1'))?.pending?.local).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toHaveLength(0);
  });

  // The important half: suppression must NOT burn the one lifetime card.
  // Muted and not-yet-explained are different states from "explained" — only
  // a send that actually goes out may mark the chat as told. Prove both
  // halves in one test: nothing arrives while muted, and unmuting then
  // hitting the SAME suppressed-dialog path again still delivers the
  // explanation exactly once (not zero — they never got it; not twice).
  it('suppressing the card for a muted chat does not spend its one lifetime explanation — unmuting still delivers it exactly once', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { render: async () => {}, clear: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toHaveLength(0); // muted → suppressed, not sent, not marked explained

    await request({ kind: 'daemon.set', key: 'mute', enabled: false }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w2', sessionId: 's2', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await waitForSent(sent);
    expect(sent).toHaveLength(1); // now unmuted — the explanation they never got still arrives, once
    const card = sent[0] as { buttons?: Array<{ id: string }> };
    expect(card.buttons?.map((b) => b.id)).toContain('mode:full');

    // A third suppressed-dialog session, same chat, must not repeat it.
    await request({ kind: 'hook.notify', cwd: '/w3', sessionId: 's3', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });
});

// bootstrap.ts's IPC layer maps BOTH 'local' and 'handback' to the wire
// decision 'defer' (permission-router.ts keeps them as distinct Decision
// values only so the settled card can tell them apart — see OUTCOME). Today
// only a type error would catch that mapping line being removed, and at
// runtime the shim would silently receive a `decision` it does not
// understand. Assert the wire AND the settlement label directly.
describe('handback (Answer at the terminal instead)', () => {
  it('maps to defer on the wire, and settles the card as "Handed back to the terminal" — not "Timed out"', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      mode: 'all',
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const adapter = interactiveAdapter('telegram', sent, edits);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);

    const pending = held(request(
      { kind: 'hook.permission.request', cwd: '/proj', sessionId: 's1', agentId: 'agentA', toolName: 'Bash', input: { command: 'date' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    ));
    await waitForSent(sent);

    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    const handbackBtn = card.buttons!.find((b) => b.id.startsWith('handback:'))!;
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: handbackBtn.id, ts: 0 });

    // The wire: CC must see a plain pass-through, exactly like a timeout/local
    // answer — never a decision it doesn't recognize, never an auto-allow.
    const r = await pending;
    expect(r).toEqual({ kind: 'hook.permission.result', decision: 'defer' });

    // The card: the distinct label is the entire justification for 'handback'
    // existing as its own Decision instead of just reusing 'defer' (whose
    // settlement label is "Timed out" — a lie here, nobody waited it out).
    expect(edits).toHaveLength(1);
    const edited = edits[0].msg as { title?: string };
    expect(edited.title).toContain('Handed back to the terminal');
    expect(edited.title).not.toContain('Timed out');
  });
});

describe('sub-agent card affordances', () => {
  it('on mode all, a held sub-agent card offers a way back to the terminal and a posture switch', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      mode: 'all',
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)] });
    const pending = held(request({ kind: 'hook.permission.request', cwd: '/proj', sessionId: 's1', toolName: 'Bash', input: { command: 'date' }, agentId: 'agentA' },
      { socketPath: daemonSocketPath(tmp), timeoutMs: 4000 }));
    await waitForSent(sent);

    const card = sent[0] as Extract<OutgoingMessage, { kind: 'card' }>;
    const ids = card.buttons!.map((b) => b.id);
    expect(ids.some((i) => i.startsWith('handback:'))).toBe(true);
    expect(ids).toContain('mode:full');
    // Task 13 defect 2: a HELD sub-agent card must mark itself as such — it has
    // no parallel terminal dialog while held, unlike a main-session card, and
    // the two must not read as indistinguishable (matches the pass-through
    // notice's own `${toolName} · sub-agent` idiom).
    expect(card.title).toContain('sub-agent');

    h.permissionRouter.cancel({ key: 's1' });
    await pending;
  });

  it('on mode full, the sub-agent pass-through notice offers to start holding them', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      mode: 'full',
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)] });
    const r = await request({ kind: 'hook.permission.request', cwd: '/proj', sessionId: 's1', toolName: 'Read', input: { file_path: '/etc/hosts' }, agentId: 'agentA' },
      { socketPath: daemonSocketPath(tmp), timeoutMs: 4000 });
    expect(r.kind === 'hook.permission.result' && r.decision).toBe('defer'); // still transparent
    await waitForSent(sent);

    const notice = sent[0] as Extract<OutgoingMessage, { kind: 'card' }>;
    expect(notice.buttons?.map((b) => b.id)).toEqual(['mode:all']);
    // The notice must NOT offer Allow/Deny — that dialog can only be answered at
    // the keyboard, and an affordance that cannot work is worse than none.
    expect(notice.buttons?.some((b) => b.id.startsWith('approve:'))).toBe(false);
  });

  it('a main-session card keeps exactly its old button set', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      mode: 'full',
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)] });
    const pending = held(request({ kind: 'hook.permission.request', cwd: '/proj', sessionId: 's1', toolName: 'Bash', input: { command: 'date' } },
      { socketPath: daemonSocketPath(tmp), timeoutMs: 4000 }));
    await waitForSent(sent);

    const card = sent[0] as Extract<OutgoingMessage, { kind: 'card' }>;
    const ids = card.buttons!.map((b) => b.id.split(':')[0]);
    expect(ids).toEqual(['approve', 'deny', 'allowtool', 'pause']);
    // Task 13 defect 2: a main-session card has a live parallel terminal dialog
    // (first answer wins) — it must NOT be marked as a sub-agent card.
    expect(card.title).not.toContain('sub-agent');

    h.permissionRouter.cancel({ key: 's1' });
    await pending;
  });
});

// Task 3: the board (src/kernel/daemon/waiting-board.ts) is now the ONLY
// input to the desktop toast — `passthruWaiting` and the old three-term
// `nothingWaiting()` predicate are gone. These tests drive the router
// directly (no IPC round-trip needed for the toast's own logic) and assert
// on `render`, not `ping` — `refreshDesktop` never calls `ping`.
describe('WaitingBoard drives the ONE desktop toast (Task 3)', () => {
  const CFG = {
    web: { enabled: false },
    approvals: { approvalGraceSec: 0 },
    adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
  };

  function fakeAdapter(): IMAdapter {
    return {
      channel: 'telegram',
      async start() { /* noop */ },
      async stop() { /* noop */ },
      async send() { return { messageId: 'm1' }; },
      async edit() { /* noop */ },
      onInbound() { /* noop */ },
      isConnected() { return 'connected' as const; },
    };
  }

  /** The requestId of the first genuinely HELD (answerable) request the
   *  registry knows about — skips read-only `pending.local` entries (a
   *  sub-agent pass-through's placeholder, or a tracked CC-native dialog),
   *  which carry a requestId nothing can `answer()`. */
  function firstPendingId(h: DaemonHandle): string {
    const found = h.sessions.list().find((s) => s.pending?.requestId && !s.pending.local);
    if (!found?.pending) throw new Error('firstPendingId: no held (non-local) pending request found');
    return found.pending.requestId;
  }

  /** Drive a sub-agent pass-through the same way `hook.permission.request`
   *  with an `agentId` does under the default (non-`all`) posture — straight
   *  to `PermissionRouter.requestPermission`, matching this describe's other
   *  direct-router calls. Resolves once the pass-through's synchronous
   *  onPassthrough side effects (board entry, IM notice) have run. */
  async function sendPassthrough(h: DaemonHandle, opts: { key: string; cwd: string; agentId: string; toolName: string }): Promise<void> {
    await h.permissionRouter.requestPermission({
      key: opts.key, cwd: opts.cwd, toolName: opts.toolName, input: {}, agentId: opts.agentId, timeoutSec: 60,
    });
  }

  it('two sessions waiting render ONE aggregated toast, and answering one re-renders the rest', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const renders: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    const adapter = fakeAdapter();
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [adapter],
      desktopNotifier: {
        render: async (title, body) => { renders.push({ title, body }); },
        clear: async () => { clears.push(1); },
      },
    });
    clears.length = 0; // discard the daemon's own startup clear (unrelated to this scenario)
    const a = h.permissionRouter.requestPermission({ key: '/w/a', cwd: '/w/a', toolName: 'Bash', input: { command: 'ls' } });
    const b = h.permissionRouter.requestPermission({ key: '/w/b', cwd: '/w/b', toolName: 'Read', input: { file_path: '/w/b/x' } });
    await until(() => { expect(renders.at(-1)!.title).toBe('2 sessions need you'); });
    expect(renders.at(-1)!.body.split('\n')).toHaveLength(2);

    h.permissionRouter.answer(firstPendingId(h), true);
    await until(() => { expect(renders.at(-1)!.title).not.toBe('2 sessions need you'); });
    expect(renders.at(-1)!.body.split('\n')).toHaveLength(1);
    expect(clears).toHaveLength(0); // still one waiting — do NOT clear

    // Clean up the still-outstanding request so the test doesn't hang waiting
    // for `b` — its default timeout (580s) far outlives this test.
    h.permissionRouter.answer(firstPendingId(h), true);
    await a; await b;
  });

  // This is the regression test the whole task exists to protect: two of the
  // three old call sites forgot `passthruWaiting`, so a main-session approval
  // resolving ANYWHERE closed a still-waiting sub-agent's toast. With the
  // predicate derived from the board, there is no separate copy left to forget.
  it('answering one session does not close a still-waiting sub-agent toast (the predicate is the board)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const clears: number[] = [];
    const renders: Array<{ title: string }> = [];
    const adapter = fakeAdapter();
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [adapter],
      desktopNotifier: {
        render: async (title) => { renders.push({ title }); },
        clear: async () => { clears.push(1); },
      },
    });
    clears.length = 0; // discard the daemon's own startup clear (unrelated to this scenario)
    // A sub-agent pass-through is outstanding …
    await sendPassthrough(h, { key: '/w/a', cwd: '/w/a', agentId: 'ag1', toolName: 'Read' });
    // … while an unrelated main-session approval arrives and is answered.
    const p = h.permissionRouter.requestPermission({ key: '/w/b', cwd: '/w/b', toolName: 'Bash', input: { command: 'ls' } });
    await until(() => { expect(renders.length).toBeGreaterThan(1); });
    h.permissionRouter.answer(firstPendingId(h), true);
    await until(() => { expect(renders.at(-1)!.title).toContain('sub-agent'); });
    expect(clears).toHaveLength(0);
    await p;
  });

  it('clears the toast once — and only once — nothing at all is waiting', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const clears: number[] = [];
    const adapter = fakeAdapter();
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [adapter],
      desktopNotifier: { render: async () => {}, clear: async () => { clears.push(1); } },
    });
    clears.length = 0; // discard the daemon's own startup clear (unrelated to this scenario)
    const p = h.permissionRouter.requestPermission({ key: '/w/a', cwd: '/w/a', toolName: 'Bash', input: { command: 'ls' } });
    await until(() => { expect(h.permissionRouter.pendingCount()).toBe(1); });
    h.permissionRouter.answer(firstPendingId(h), true);
    await until(() => { expect(clears).toHaveLength(1); });
    await p;
  });

  // Regression guard for the old `desktopOn && webUrl != null`: whether a
  // toast was drawn says nothing about whether the dashboard can answer. A
  // dashboard URL alone is the local answer path — no desktop input belongs
  // in the predicate at all.
  it('a dashboard URL alone makes an approval locally answerable — no desktop input in the predicate', async () => {
    // port 0 → ephemeral; inject via config to avoid port conflicts (same
    // pattern as web-bootstrap.test.ts) — this test needs web ENABLED
    // (unlike this describe's shared CFG, which disables it).
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    const adapter = fakeAdapter();
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [adapter],
      desktopNotifier: { render: async () => {}, clear: async () => {} },
    });
    expect(h.webUrl).toBeTruthy();
    const p = h.permissionRouter.requestPermission({ key: '/w/a', cwd: '/w/a', toolName: 'Bash', input: { command: 'ls' } });
    await until(() => { expect(h.permissionRouter.pendingCount()).toBe(1); }); // held, not deferred
    h.permissionRouter.answer(firstPendingId(h), true);
    await p;
  });

  // Task 9: the toast is resident, so on a server advertising the
  // `persistence` capability, --replace-id updates it in place and silently
  // — no banner. The decision lives in `refreshDesktop`, so prove it end to
  // end: a NEW waiting thing must alert; answering one of several must not.
  it('a second session needing you re-alerts; answering one of them does not', async () => {
    // port 0 → ephemeral: this test needs a real answer surface (web enabled)
    // so the router HOLDS the request instead of resolving it immediately as
    // unanswerable, but the fixed default port collides with a real tlive
    // daemon that may already be running on this machine (same fix as "a
    // dashboard URL alone…" above).
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    const renders: Array<{ title: string; alert: boolean }> = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: {
        render: async (title, _b, o) => { renders.push({ title, alert: !!o?.alert }); },
        clear: async () => {},
      },
    });
    const a = h.permissionRouter.requestPermission({ key: '/w/a', cwd: '/w/a', toolName: 'Bash', input: { command: 'ls' } });
    await until(() => { expect(renders).toHaveLength(1); });
    expect(renders[0]!.alert).toBe(true);                       // first thing waiting → alert
    const b = h.permissionRouter.requestPermission({ key: '/w/b', cwd: '/w/b', toolName: 'Read', input: { file_path: '/w/b/x' } });
    await until(() => { expect(renders).toHaveLength(2); });
    expect(renders[1]!.alert).toBe(true);                       // a NEW one → alert
    h.permissionRouter.answer(firstPendingId(h), true);
    await until(() => { expect(renders).toHaveLength(3); });
    expect(renders[2]!.alert).toBe(false);                      // one answered → silent
    // Clean up the still-outstanding request so the test doesn't hang waiting
    // for the other of `a`/`b` — its default timeout (580s) far outlives this
    // test (same pattern as "two sessions waiting render ONE aggregated
    // toast" above).
    h.permissionRouter.answer(firstPendingId(h), true);
    await a; await b;
  });

  // Coverage gap flagged in review round 1: the test above only ever adds
  // entries with fresh (router-generated UUID) requestIds, which never
  // repeat across requests — so it cannot fail even if `refreshDesktop`'s
  // empty-board reset (`lastBoardIds = new Set()`) were deleted; a brand-new
  // UUID is never "in" the remembered set regardless of whether that set was
  // ever cleared. Verified: temporarily commenting out the reset line still
  // left that test green.
  //
  // The idle reminder's board id (`idle:<key>`, deterministic per session —
  // see `idleBoardId` in bootstrap.ts) is what actually reuses an id across
  // separate waiting episodes, so it is the real repro: retire it fully
  // (board empties → clear()), then have the SAME session go idle again.
  // Without the reset, that returning id would still read as "already seen"
  // and stay silent — the exact silent-forever bug this task exists to fix,
  // returning through the empty-board door instead of the --replace-id door.
  it('an idle reminder that returns after the board fully emptied alerts again, even though it reuses the same board id', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const renders: Array<{ title: string; alert: boolean }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: {
        render: async (title, _b, o) => { renders.push({ title, alert: !!o?.alert }); },
        clear: async () => { clears.push(1); },
      },
    });
    const sock = daemonSocketPath(tmp);
    clears.length = 0; // discard the daemon's own startup clear (unrelated to this scenario)
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(renders.length).toBeGreaterThan(0); });
    expect(renders[0]!.alert).toBe(true);                       // first arrival → alert
    // The user types → the idle reminder retires, and (nothing else waiting) the board empties.
    // (clearLocalPrompt's own unconditional refreshDesktop — a no-op local-prompt
    // removal that fires regardless — can interleave one harmless extra silent
    // render here before the idle entry itself is removed; asserting on the
    // COUNT rather than a fixed index keeps this test robust to that.)
    await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/w', sessionId: 's1', prompt: 'go on' } }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(clears).toHaveLength(1); });     // board fully emptied → remembered set reset
    const rendersBeforeReturn = renders.length;
    // The SAME session goes idle again — same board id (`idle:/w`) as before,
    // but this is a genuinely new waiting episode after a full empty.
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(renders.length).toBeGreaterThan(rendersBeforeReturn); });
    expect(renders.at(-1)!.alert).toBe(true);                   // must alert again, not read as "already seen"
  });
});

// Task 10: the desktop toast was the one surface that left no trace at all —
// a 4.3 MB daemon.log from a real session contained zero lines matching
// `desktop|toast|notify-send`. These tests lock the two lines that make it
// observable: `desktop.channel` (factory time, covered directly in
// desktop-notify.test.ts) and refreshDesktop's own `desktop.render`/
// `desktop.clear` per projection, asserted here through `onLog`.
describe('desktop channel + projection logging is observable from the log alone (Task 10)', () => {
  /** Drive the idle "waiting for your input" board entry the same way the CC
   *  hook layer does — a plain `hook.notify` IPC call (level: 'info', no
   *  permissionPrompt) — matching every other `hook.notify` call in this file,
   *  just named at this call site for readability. */
  async function notifyIdle(handle: DaemonHandle, opts: { cwd: string; sessionId: string }): Promise<void> {
    await request(
      { kind: 'hook.notify', cwd: opts.cwd, sessionId: opts.sessionId, level: 'info', message: 'Claude is waiting for your input' },
      { socketPath: handle.ipcSocketPath, timeoutMs: 2000 },
    );
  }

  it('logs every projection with the alert flag — the field that explains a silent channel', async () => {
    // A run of alert:false after one alert:true is the signature of a toast being
    // updated in place instead of re-raised, which is invisible without this line.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { render: async () => {}, clear: async () => {} },
      onLog: (msg, fields) => { lines.push({ msg, fields }); },
    });
    await notifyIdle(h, { cwd: '/w/a', sessionId: 's1' });
    await until(() => { expect(lines.some((l) => l.msg === 'desktop.render')).toBe(true); });
    const rendered = lines.filter((l) => l.msg === 'desktop.render');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.fields).toEqual({ alert: true, count: 1, kinds: ['idle'] });
  });

  // Deferred Minor from Task 9's review: a board entry re-added under the SAME
  // id (a re-render of the same dialog) must not raise a banner — even when the
  // rendered TEXT genuinely differs between the two renders. WaitingBoard.add's
  // Map upsert replaces an entry's content but keeps its id, and `alert` must
  // be computed from ids alone; a version of this test that used two
  // byte-identical notifyIdle calls (same label, same constant `what`) could
  // not tell that apart from a future regression that made `alert` sensitive
  // to wording — so this one forces the text to change: the idle board's
  // rendered title carries the session's CURRENT label, read live at render
  // time (`sessionLabel` in bootstrap.ts), so changing the registered label
  // between the two calls changes the title under the exact same `idle:s1` id.
  it('a same-id re-render with a genuinely different label does not alert', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const renders: Array<{ title: string; alert: boolean }> = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { render: async (t, _b, o) => { renders.push({ title: t, alert: !!o?.alert }); }, clear: async () => {} },
    });
    h.sessions.upsert({ key: 's1', cwd: '/w/a', label: 'first-label' });
    await notifyIdle(h, { cwd: '/w/a', sessionId: 's1' });
    await until(() => { expect(renders.length).toBe(1); });
    expect(renders[0]!.title).toBe('first-label · your input');
    h.sessions.upsert({ key: 's1', cwd: '/w/a', label: 'second-label' }); // same idle:s1 id, different text next render
    await notifyIdle(h, { cwd: '/w/a', sessionId: 's1' });
    await until(() => { expect(renders.length).toBe(2); });
    expect(renders[1]!.title).toBe('second-label · your input'); // the text really did change …
    expect(renders.map((r) => r.alert)).toEqual([true, false]);  // … yet it must not alert
  });

  // Finding 2 (fix round 1): refreshDesktop runs after every board removal,
  // most of which are no-ops against an already-empty board (e.g.
  // clearLocalPrompt's unconditional refresh, hit on every main-session
  // `activity`/`prompt` event). Logging `desktop.clear` unconditionally there
  // would emit one content-free line per such event — hundreds per session —
  // burying the handful of `desktop.render` lines this task exists to
  // surface. Only the REAL transition (something was on the board, now it
  // is not) may log.
  it('a refresh on an already-empty board logs no desktop.clear line', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { render: async () => {}, clear: async () => {} },
      onLog: (msg, fields) => { lines.push({ msg, fields }); },
    });
    const sock = h.ipcSocketPath;
    // One real transition: something waits, then the user types → the idle
    // entry retires and the board empties → exactly one `desktop.clear`.
    await notifyIdle(h, { cwd: '/w/a', sessionId: 's1' });
    await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/w/a', sessionId: 's1', prompt: 'go on' } }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(lines.filter((l) => l.msg === 'desktop.clear')).toHaveLength(1); });
    // A second, unrelated `prompt` event on the SAME (already-empty) board —
    // this is exactly clearLocalPrompt's + the idle-removal's own
    // unconditional refreshDesktop pair, both hitting an empty board — must
    // add no further `desktop.clear` line.
    await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/w/a', sessionId: 's1', prompt: 'again' } }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(lines.filter((l) => l.msg === 'desktop.clear')).toHaveLength(1);
  });
});

// Task 11: retiring one of several waiting things fires refreshDesktop TWICE in
// the same tick — clearLocalPrompt's own unconditional refresh, then the idle
// removal's unconditional refresh right after it (see clearLocalPrompt's and
// the `prompt` handler's doc comments). Both computed the same view and both
// logged/rendered, so answering one of several things waiting produced two
// byte-identical `desktop.render` lines and a spare notify-send. A projection
// byte-identical to the last one ACTUALLY rendered, with alert:false, is now
// skipped entirely: no notifier call, no log line.
describe('a projection identical to the last one actually rendered is skipped (Task 11)', () => {
  /** Drive a CC-native permission dialog onto the board exactly like a real
   *  `permission_prompt` Notification does — matching every other
   *  `permissionPrompt: true` `hook.notify` call in this file, just named here
   *  for readability alongside `hookPrompt`. */
  async function notifyLocalPrompt(handle: DaemonHandle, opts: { cwd: string; sessionId: string }): Promise<void> {
    await request(
      { kind: 'hook.notify', cwd: opts.cwd, sessionId: opts.sessionId, level: 'info', message: 'Claude needs your permission to use Bash', permissionPrompt: true },
      { socketPath: handle.ipcSocketPath, timeoutMs: 2000 },
    );
  }

  /** New terminal input for a session — retires its tracked local dialog AND
   *  its idle reminder, each via its own unconditional `refreshDesktop()` call.
   *  This is the exact pairing the bug report drove (see the describe's header
   *  comment). */
  async function hookPrompt(handle: DaemonHandle, opts: { cwd: string; sessionId: string }): Promise<void> {
    await request(
      { kind: 'hook.event', event: { event: 'prompt', cwd: opts.cwd, sessionId: opts.sessionId, prompt: 'go on' } },
      { socketPath: handle.ipcSocketPath, timeoutMs: 2000 },
    );
  }

  it('a projection that would change nothing does not reach the notifier', async () => {
    const renders: Array<{ title: string; alert: boolean }> = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { render: async (title, _b, o) => { renders.push({ title, alert: !!o?.alert }); }, clear: async () => {} },
    });
    await notifyLocalPrompt(h, { cwd: '/w/a', sessionId: 'a' });
    await notifyLocalPrompt(h, { cwd: '/w/b', sessionId: 'b' });
    const before = renders.length;
    // Retiring 'a' fires refreshDesktop twice in the same tick (clearLocalPrompt,
    // then the idle removal); only the first changes anything.
    await hookPrompt(h, { cwd: '/w/a', sessionId: 'a' });
    expect(renders.length - before).toBe(1);
  });

  it('an identical view returning after the board emptied still renders', async () => {
    // Wiring only. This does NOT pin the `!alert` half of the skip condition:
    // the board passes through an empty state here, and the `lastBoardIds`
    // reset there forces alert:true by a different mechanism, so this test
    // stays green with `!alert` removed. The clause is pinned by
    // canSkipProjection's unit tests ('identical view, alert:true'), which is
    // why that decision was extracted into a pure function. Do not read this
    // test as proof that text equality alone is insufficient.
    const renders: Array<{ alert: boolean }> = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { render: async (_t, _b, o) => { renders.push({ alert: !!o?.alert }); }, clear: async () => {} },
    });
    // Drive the board directly through two sessions that render the same line.
    // If the harness cannot produce identical text from two keys, assert the
    // condition at the unit level instead: identical view + alert:true must render.
    await notifyLocalPrompt(h, { cwd: '/w/same', sessionId: 's1' });
    const before = renders.length;
    await hookPrompt(h, { cwd: '/w/same', sessionId: 's1' });   // board empties
    await notifyLocalPrompt(h, { cwd: '/w/same', sessionId: 's1' });  // same text, new arrival
    expect(renders.at(-1)!.alert).toBe(true);
    expect(renders.length).toBeGreaterThan(before);
  });

  it('the remembered view is dropped when the board empties, so a returning state still renders', async () => {
    const renders: string[] = []; const clears: number[] = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { render: async (title) => { renders.push(title); }, clear: async () => { clears.push(1); } },
    });
    await notifyLocalPrompt(h, { cwd: '/w/a', sessionId: 'a' });
    const first = renders.length;
    await hookPrompt(h, { cwd: '/w/a', sessionId: 'a' });        // empties -> clear
    await until(() => { expect(clears.length).toBeGreaterThan(0); });
    await notifyLocalPrompt(h, { cwd: '/w/a', sessionId: 'a' }); // identical view returns
    expect(renders.length).toBeGreaterThan(first);
  });
});
