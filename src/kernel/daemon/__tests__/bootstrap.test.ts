import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapDaemon, shouldFastNullContinue, clampPermissionTimeout, makeCodexResumeHandler, shouldDropNotify, resolveKey, type DaemonHandle } from '../bootstrap';
import { request, daemonSocketPath } from '../../ipc/client';
import type { IMAdapter, IMChannel, OutgoingMessage, IncomingEnvelope } from '../../contracts/im-adapter';
import { SessionRegistry } from '../../web/session-registry';
import { until } from '../../__tests__/wait.js';
import { writeMode } from '../../config/mode.js';

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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); }, info: async () => {} } });
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

  it('desktop ping is immediate — it does NOT wait out the IM card grace delay (the local user is the whole point)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 30 }, // IM card held back 30s…
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); }, info: async () => {} } });
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

  it('daemon.set desktop off (the `tlive desktop off` CLI wire) silences the toast and clears the live one', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); }, info: async () => {} } });
    const sock = daemonSocketPath(tmp);
    const off = await request({ kind: 'daemon.set', key: 'desktop', enabled: false }, { socketPath: sock, timeoutMs: 2000 });
    expect(off.kind).toBe('ack');
    expect(clears.length).toBeGreaterThan(0); // turning off clears any live toast
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(sent).toHaveLength(1); });
    expect(notes).toHaveLength(0); // toast gated off; the IM card still went out
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
  });

  it('two configured chats with a slow adapter still get ONE desktop ping per request (regression: per-chat concurrent pushes each fired a toast)', async () => {
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [tg, fs], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); }, info: async () => {} } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'touch /x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(sent).toHaveLength(2); }); // one card per channel…
    expect(notes).toHaveLength(1); // …but a single desktop ping
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    tg.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
  });

  it('a finished turn does NOT pop a desktop banner (per-turn completion would flood) — it stays on IM only', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const infos: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async () => {}, clear: async () => {}, info: async (title, body) => { infos.push({ title, body }); } } });
    // Drive the real, shared continueBroker directly (same instance the CC Stop
    // and Codex turn/completed paths both funnel through). Floating request with
    // a tiny window; we only assert the notification surfaces, not the reply.
    void h.continueBroker.request({ cwd: '/w', context: 'Finished building the feature', timeoutSec: 1 });
    await until(() => { expect(sent).toHaveLength(1); }); // …still surfaced on IM
    expect(infos).toHaveLength(0); // no desktop flood on completion…
    expect((sent[0] as { title?: string }).title).toContain('Turn finished');
  });

  it('info-level notify ("Claude is waiting for your input") fires a desktop banner; error-level (failures) does NOT', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const infos: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { ping: async () => {}, clear: async () => {}, info: async (title, body) => { infos.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    expect(infos).toHaveLength(1);
    expect(infos[0].body).toContain('waiting for your input');
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'error', message: 'Bash failed: boom' }, { socketPath: sock, timeoutMs: 2000 });
    expect(infos).toHaveLength(1); // error-level stays on IM/dashboard, never the at-the-keyboard banner
  });

  it('desktop waiting banner is INDEPENDENT of IM mute (IM ⊥ desktop): /mute on silences IM but the desktop info still fires', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const infos: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async () => {}, clear: async () => {}, info: async (t, b) => { infos.push({ title: t, body: b }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 }); // /mute on
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    expect(infos).toHaveLength(1); // desktop fires despite the IM mute…
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
  // onPending's desktop ping also renders sessionTag(key) — and used to do so
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
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
  it('fires ONE desktop ping naming the tool when a sub-agent request passes through', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
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
  // onPassthrough's desktop ping also renders sessionTag(key) before its own
  // guarded upsert registered the session, so a sub-agent's first-ever
  // pass-through (e.g. right after a daemon restart) produced an unlabelled toast.
  it('a sub-agent pass-through for a never-before-seen session still carries the "<label> · " toast prefix', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
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

  // IM ⊥ desktop: `/mute` is an IM-only switch. The old early-return at the
  // top of onPassthrough killed the WHOLE announcement on mute, which broke
  // that rule for this notice specifically.
  it('IM mute silences the card, but the desktop ping still fires (IM ⊥ desktop)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); }, info: async () => {} } });
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
  // through onResolved specifically: s1's sub-agent dialog is untouched
  // (nothing retires it in this test) while a genuinely separate, genuinely
  // held main-session approval on s2 gets answered via IM.
  it("a held approval resolving on ANOTHER session must not close the toast while a sub-agent pass-through is still outstanding (onResolved)", async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); }, info: async () => {} } });
    const sock = daemonSocketPath(tmp);

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

    // Only once s1's notice actually retires does the toast close.
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', result: {} } },
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => { clears.push(1); }, info: async () => {} } });
    const sock = daemonSocketPath(tmp);

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

describe('permission_prompt forwarding — the notify-mode / immediate-defer notification chain (issue #49)', () => {
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

  it('no held request → desktop ping + read-only waiting-approval card + IM text (the chain a silent hang used to be)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    // Desktop: the waiting slot (ping), speaking to the person at the machine.
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('Permission needed');
    expect(notes[0].body).toContain('answer in the terminal');
    // Dashboard: read-only pending — waiting-approval, marked local.
    const s = await findSession(sock, 's1');
    expect(s?.status).toBe('waiting-approval');
    expect(s?.pending?.local).toBe(true);
    expect(s?.pending?.body).toBe(MSG);
    // IM: plain text (grace 0 here), pointing back at the terminal.
    await waitForSent(sent);
    expect(sent[0]).toMatchObject({ kind: 'text' });
    expect((sent[0] as { text: string }).text).toContain('answer in the terminal');
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
    const sock = daemonSocketPath(tmp);

    writeMode(tmp, 'notify');

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    // Now on 'notify' — the chain must run: it is the only signal a dialog is waiting.
    expect(notes).toHaveLength(1);
    expect((await findSession(sock, 's1'))?.pending?.local).toBe(true);
    await waitForSent(sent);
    expect((sent[0] as { text: string }).text).toContain('answer in the terminal');
  });

  it('notify mode still sends the IM text — there it is the only signal a dialog is waiting', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    await waitForSent(sent);
    expect((sent[0] as { text: string }).text).toContain('answer in the terminal');
  });

  it('a held request for the same session already owns every surface → the notification is dropped (full-mode dedupe)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
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

  it('a local answer (main-session PostToolUse) retires the chain: pending gone, toast closed, graced IM text never sent', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, approvals: { approvalGraceSec: 30 } }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const clears: number[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async () => {}, clear: async () => { clears.push(1); }, info: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    expect((await findSession(sock, 's1'))?.status).toBe('waiting-approval');

    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Bash', result: {} } }, { socketPath: sock, timeoutMs: 2000 });

    const s = await findSession(sock, 's1');
    expect(s?.status).toBe('active');
    expect(s?.pending).toBeUndefined();
    expect(clears.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0); // answered within grace → the IM text never fires
  });

  it('sub-agent activity does NOT retire the main-session dialog tracking (parallel agents keep running while you look at the dialog)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async () => {}, clear: async () => {}, info: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Read', result: {}, agentId: 'agentA' } }, { socketPath: sock, timeoutMs: 2000 });

    const s = await findSession(sock, 's1');
    expect(s?.pending?.local).toBe(true); // still waiting — only a MAIN-session answer clears it
  });

  it('muted IM stays quiet, but desktop + dashboard still fire (IM ⊥ desktop)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { ping: async (title, body) => { notes.push({ title, body }); }, clear: async () => {}, info: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, permissionPrompt: true }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(1);
    expect((await findSession(sock, 's1'))?.pending?.local).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toHaveLength(0);
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

    h.permissionRouter.cancel({ key: 's1' });
    await pending;
  });
});
