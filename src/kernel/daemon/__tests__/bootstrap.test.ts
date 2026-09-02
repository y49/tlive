import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapDaemon, shouldFastNullContinue, clampPermissionTimeout, makeCodexResumeHandler, resolveKey, detectLang, type DaemonHandle } from '../bootstrap';
import type { CodexRpcEvents } from '../../codex/rpc';
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

// bootstrapDaemon calls detectLang(process.env) exactly once, at startup —
// every notification-copy assertion in this file below assumes the result is 'en'.
// That assumption must not ride on whatever locale happens to be set in the
// environment actually running this suite (this repo's own dev machine runs
// zh_CN.UTF-8): saving and clearing LC_ALL/LC_MESSAGES/LANG around every test
// makes 'en' the suite's deterministic default, the same way `tmp` isolates
// each test from a shared HOME. The one test that exercises detectLang's zh
// path end to end sets its own LC_ALL inside the test body.
let origLocale: { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string };

beforeEach(() => {
  // Captured BEFORE mkdtempSync: if mkdtempSync throws on the very first test,
  // afterEach must still find a defined origLocale to restore from — otherwise
  // it dereferences undefined and reports a TypeError that masks the real disk
  // error instead of just running the (harmless, already-clear) restore.
  origLocale = { LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG };
  delete process.env.LC_ALL; delete process.env.LC_MESSAGES; delete process.env.LANG;
  tmp = mkdtempSync(join(tmpdir(), 'tlive-d-'));
});
afterEach(async () => {
  // shutdown() runs inside try/finally: if it rejects, the locale restore
  // below must still happen — otherwise a leaked LC_ALL='zh_CN.UTF-8' (set by
  // a zh-path test) survives into the next beforeEach's snapshot and pins
  // Chinese for the rest of the file, turning one hook failure into a cascade
  // of confusing English-assertion failures in unrelated later tests.
  try {
    await h?.shutdown();
  } finally {
    if (origLocale.LC_ALL === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = origLocale.LC_ALL;
    if (origLocale.LC_MESSAGES === undefined) delete process.env.LC_MESSAGES; else process.env.LC_MESSAGES = origLocale.LC_MESSAGES;
    if (origLocale.LANG === undefined) delete process.env.LANG; else process.env.LANG = origLocale.LANG;
  }
});

describe('detectLang (OS locale → notification language)', () => {
  it('resolves zh for zh_CN.UTF-8, zh-Hans, and bare zh', () => {
    expect(detectLang({ LANG: 'zh_CN.UTF-8' })).toBe('zh');
    expect(detectLang({ LANG: 'zh-Hans' })).toBe('zh');
    expect(detectLang({ LANG: 'zh' })).toBe('zh');
  });

  it('an unrecognised locale falls back to en on purpose', () => {
    expect(detectLang({ LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(detectLang({ LANG: 'ja_JP.UTF-8' })).toBe('en');
  });

  it('nothing set at all (a bare C/POSIX environment) also falls back to en', () => {
    expect(detectLang({})).toBe('en');
    expect(detectLang({ LANG: 'C' })).toBe('en');
    expect(detectLang({ LANG: 'POSIX' })).toBe('en');
  });

  it('POSIX precedence: LC_ALL beats LC_MESSAGES beats LANG', () => {
    expect(detectLang({ LC_ALL: 'zh_CN.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(detectLang({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(detectLang({ LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' })).toBe('en');
  });
});

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
  // switch for the desktop channel). A stale CLI still shipping `daemon.set
  // key=desktop` must get a loud error, not silently land on whichever branch
  // happens to be last in the dispatch.
  it('daemon.set no longer accepts the retired desktop key', async () => {
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async () => {} } });
    const r = await request({ kind: 'daemon.set', key: 'desktop', enabled: false } as never, { socketPath: h.ipcSocketPath, timeoutMs: 2000 });
    expect(r.kind).toBe('error');
  });

  it('a second daemon against the same home fails to bind', async () => {
    h = await bootstrapDaemon({ home: tmp, imAdapters: [] });
    await expect(bootstrapDaemon({ home: tmp, imAdapters: [] })).rejects.toBeInstanceOf(AlreadyRunningError);
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

describe('makeCodexResumeHandler', () => {
  function fakeEvents(size = 1) {
    const broadcast = (v: unknown) => broadcasts.push(v);
    const broadcasts: unknown[] = [];
    return { broadcast, size: () => size, broadcasts };
  }

  function rig(over: Partial<Parameters<typeof makeCodexResumeHandler>[0]> = {}) {
    const notified: unknown[] = [];
    const reports: Array<{ key: string; message: string }> = [];
    const events = fakeEvents(1);
    const sessions = new SessionRegistry();
    let requested = false;
    const handler = makeCodexResumeHandler({
      broker: { request: async () => { requested = true; return null; } },
      sessions,
      events,
      chats: () => [{}],
      resume: async () => undefined,
      gracePassed: async () => true,
      notifyTurn: () => notified.push(1),
      reportFailure: (p) => reports.push(p),
      ...over,
    });
    return { handler, notified, reports, events, sessions, wasRequested: () => requested };
  }

  it('a completed Codex turn with no assistant message announces nothing — there is nothing to come back to', async () => {
    const { handler, notified, reports, events, wasRequested } = rig();
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'completed' }); // nothing was produced
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(notified).toHaveLength(0); // no desktop notification…
    expect(wasRequested()).toBe(false); // …and no IM continue card either
    expect(reports).toHaveLength(0);    // …and nothing failed, so nothing to report
    // The dashboard still learns the session is idle: that part is honest.
    expect(events.broadcasts.some((b: any) => b.session?.status === 'idle')).toBe(true);
  });

  // You typed a reply on your phone and pressed send. If Codex will not take
  // it, the ONE thing that must not happen is silence: a delivered reply is
  // silent too, so silence cannot tell you which of the two happened. Real
  // failure, seen 15 times on this machine on 2026-08-18: `thread/resume` and
  // `turn/start` both reject with "no rollout found for thread id …" once the
  // thread's rollout is gone.
  it('a reply Codex refuses to take is reported back — silence would be indistinguishable from success', async () => {
    const { handler, reports, events } = rig({
      broker: { request: async () => 'keep going' },
      resume: async () => { throw new Error('no rollout found for thread id t1'); },
    });
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'completed', lastMessage: 'done' });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(reports).toEqual([{ key: 'codex:t1', message: 'Reply not delivered — no rollout found for thread id t1' }]);
  });

  it('a reply Codex refuses to take leaves the session idle, not active — nothing is running', async () => {
    const { handler, events } = rig({
      broker: { request: async () => 'keep going' },
      resume: async () => { throw new Error('no rollout found for thread id t1'); },
    });
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'completed', lastMessage: 'done' });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const last = (events.broadcasts as any[]).filter((b) => b.session).pop();
    expect(last.session.status).toBe('idle');
  });

  it('a reply Codex DOES take reports nothing and leaves the session active', async () => {
    const { handler, reports, events } = rig({
      broker: { request: async () => 'keep going' },
      resume: async () => undefined,
    });
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'completed', lastMessage: 'done' });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(reports).toHaveLength(0);
    const last = (events.broadcasts as any[]).filter((b) => b.session).pop();
    expect(last.session.status).toBe('active');
  });

  // Same silence test the Claude Code side uses, and now for the same reason: a
  // thread that came back needed nobody told.
  //
  // This used to assert the opposite, on the argument that "your turn" goes
  // stale when you continue it yourself while a failure that happened stays
  // true. True is not the bar — actionable is. A failure whose thread came back
  // asks you to watch rather than to act, which is what eight identical
  // `server_error` lines in forty-six minutes felt like on the Claude Code side
  // before it started waiting. The other half of that argument, that this
  // matches the Claude Code tool-failure path, is simply false now: that path
  // reports nowhere at all.
  it('a failed turn whose thread came back inside the grace tells nobody', async () => {
    const { handler, reports, events } = rig({ gracePassed: async () => false });
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'failed', errorMessage: '503' });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(reports).toHaveLength(0);
    // The dashboard is told regardless: the thread did go idle, and that is
    // true whether or not anyone is pushed about it.
    expect(events.broadcasts.some((b: any) => b.session?.status === 'idle')).toBe(true);
  });

  it('a failed turn is reported instead of announced as finished', async () => {
    // Real incident: nine Codex threads in fourteen minutes, every turn killed
    // by a 401 against a third-party relay. tlive announced nine FINISHED turns
    // with empty bodies. Then the empty-body guard turned that into nine
    // silences, which is better and still wrong: the one thing the user needed
    // was the reason.
    const { handler, notified, reports, events, wasRequested } = rig();
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'failed', errorMessage: 'unexpected status 401 Unauthorized' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(reports).toEqual([{ key: 'codex:t1', message: 'Codex turn failed: unexpected status 401 Unauthorized' }]);
    // A failure is not blocking, so it does not reach the desktop, and it must
    // not offer a reply that resumes a thread about to fail the same way.
    expect(notified).toHaveLength(0);
    expect(wasRequested()).toBe(false);
    expect(events.broadcasts.some((b: any) => b.session?.status === 'idle')).toBe(true);
  });

  it('a failed turn with no error detail still says something', async () => {
    const { handler, reports } = rig();
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'failed' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(reports[0]!.message).toBe('Codex turn failed (no error detail)');
  });

  it('an interrupted turn says nothing at all — you pressed Esc, you already know', async () => {
    const { handler, notified, reports, events, wasRequested } = rig();
    handler({ threadId: 't1', key: 'codex:t1', lastMessage: 'half an answer', outcome: 'interrupted' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(reports).toHaveLength(0);
    expect(notified).toHaveLength(0);
    expect(wasRequested()).toBe(false);
    expect(events.broadcasts.some((b: any) => b.session?.status === 'idle')).toBe(true);
  });

  it('a finished Codex turn notifies the desktop, exactly like a finished Claude Code turn', async () => {
    // Codex reaches the desktop for approvals already — the companion goes
    // through the same PermissionRouter — but its turn/completed path never did,
    // so the same machine notified you for one vendor and stayed silent for the
    // other. Nothing about "your turn" is vendor-specific.
    const notified: Array<{ key: string; lastMessage?: string }> = [];
    const handler = makeCodexResumeHandler({
      broker: { request: async () => null },
      sessions: new SessionRegistry(),
      events: fakeEvents(1),
      chats: () => [],
      resume: async () => undefined,
      gracePassed: async () => true,
      notifyTurn: (p) => notified.push(p),
      reportFailure: () => {},
    });
    handler({ threadId: 't1', key: 'codex:t1', lastMessage: 'patch applied', outcome: 'completed' });
    await until(() => { expect(notified).toHaveLength(1); });
    expect(notified[0]).toEqual({ key: 'codex:t1', lastMessage: 'patch applied' });
  });

  it('notifies even when nothing can answer — the desktop is not an answer surface', async () => {
    const notified: Array<{ key: string; lastMessage?: string }> = [];
    const handler = makeCodexResumeHandler({
      broker: { request: async () => { throw new Error('broker must not be reached'); } },
      sessions: new SessionRegistry(),
      events: fakeEvents(0), // no dashboard client…
      chats: () => [],       // …and no IM chat: the fast-null path
      resume: async () => undefined,
      gracePassed: async () => true,
      notifyTurn: (p) => notified.push(p),
      reportFailure: () => {},
    });
    handler({ threadId: 't1', key: 'codex:t1', lastMessage: 'done', outcome: 'completed' });
    await until(() => { expect(notified).toHaveLength(1); });
  });

  it('continuing inside the grace notifies nobody — same filter Claude Code gets', async () => {
    const notified: unknown[] = [];
    const handler = makeCodexResumeHandler({
      broker: { request: async () => null },
      sessions: new SessionRegistry(),
      events: fakeEvents(1),
      chats: () => [],
      resume: async () => undefined,
      gracePassed: async () => false, // turn/started arrived inside the grace
      notifyTurn: () => notified.push(1),
      reportFailure: () => {},
    });
    handler({ threadId: 't1', key: 'codex:t1', lastMessage: 'done', outcome: 'completed' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(notified).toHaveLength(0);
  });

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
      gracePassed: async () => true,
      notifyTurn: () => {},
      reportFailure: () => {},
    });
    handler({ threadId: 't1', key: 'codex:t1', lastMessage: 'done', outcome: 'completed' });
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
      gracePassed: async () => true,
      notifyTurn: () => {},
      reportFailure: () => {},
    });
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'completed' });
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
      gracePassed: async () => true,
      notifyTurn: () => {},
      reportFailure: () => {},
    });
    handler({ threadId: 't1', key: 'codex:t1', outcome: 'completed' });
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

  it('the companion waits for an app-server to exist before connecting', async () => {
    // Custody no longer bails out when codex is absent - it keeps watching, so
    // installing codex later recovers without a tlive restart. The cost of that
    // is that every machine WITHOUT Codex would otherwise get a companion
    // looping on a socket that will never exist, logging a failure every 30s.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, adapters: {} }));
    let connects = 0;
    let report: ((s: 'running' | 'degraded' | 'off') => void) | undefined;
    h = await bootstrapDaemon({
      home: tmp,
      ensureAppServer: async (o: any) => { report = o.onStateChange; report?.('off'); return { adopted: false, stop: () => {} }; },
      connectCodex: async () => {
        connects += 1;
        return { call: async () => ({ data: [] }), notify: () => {}, close: () => {} };
      },
    });
    expect(connects).toBe(0);          // nothing to connect to, so nothing tries

    report!('running');                // an app-server appeared
    await until(() => { expect(connects).toBe(1); });
    report!('running');                // idempotent: one companion, not one per report
    await new Promise((r) => setTimeout(r, 20));
    expect(connects).toBe(1);
  });

  it('a Codex approval sends no IM card in the default posture, and none at all when off', async () => {
    // The ladder promised this and only the Claude Code shim delivered it: the
    // companion held and carded Codex approvals in every posture, so `notify`
    // put approvals on a phone the user never opted into and `off` was not a
    // kill switch at all.
    const sent: string[] = [];
    const adapter: IMAdapter = {
      channel: 'telegram',
      async start() {}, async stop() {},
      async send(out: OutgoingMessage) { sent.push(out.kind); return { messageId: 'm1' }; },
      async edit() {}, onInbound() {}, isConnected() { return 'connected' as const; },
    };
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false }, mode: 'notify',
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
      approvals: { approvalGraceSec: 0 },
    }));
    let events: CodexRpcEvents | undefined;
    h = await bootstrapDaemon({
      home: tmp,
      imAdapters: [adapter],
      ensureAppServer: async (o: any) => { o.onStateChange?.('running'); return { adopted: true, stop: () => {} }; },
      connectCodex: async (e) => { events = e; return { call: async () => ({ data: [] }), notify: () => {}, close: () => {} }; },
    });
    await until(() => { expect(events).toBeDefined(); });

    const respond = vi.fn();
    events!.onServerRequest(1, 'item/commandExecution/requestApproval', { threadId: 'T9', command: ['bash', '-lc', 'rm -rf /'] }, respond);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.filter((k) => k === 'card')).toHaveLength(0); // no approval card on notify
    expect(respond).not.toHaveBeenCalled();                   // and nothing answered for you
  });

  it('a failed Codex turn reaches IM through the real wiring, not a stand-in', async () => {
    // Everything below this line was previously covered only with an injected
    // reportFailure, i.e. the assertion stopped exactly where the hand-written
    // wiring began: configuredChats, sendToChat, the mute gate and the session
    // key all went untested. This drives the companion's own notifications.
    const sent: string[] = [];
    const adapter: IMAdapter = {
      channel: 'telegram',
      async start() {}, async stop() {},
      async send(out: OutgoingMessage) { if (out.kind === 'text') sent.push(out.text); return { messageId: 'm1' }; },
      async edit() {}, onInbound() {}, isConnected() { return 'connected' as const; },
    };
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      // A one-second silence, not the fifteen-second default: this asserts the
      // report reaches IM through the real wiring, and the wait in front of it
      // is covered by its own test.
      approvals: { continueGraceSec: 1 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    let events: CodexRpcEvents | undefined;
    const logLines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logLines.push(a.join(' ')); });
    try {
    h = await bootstrapDaemon({
      home: tmp,
      imAdapters: [adapter],
      // Reports running like a real adopted custody does — that report is what
      // starts the companion now, so a fake that stays silent means no companion.
      ensureAppServer: async (o: any) => { o.onStateChange?.('running'); return { adopted: true, stop: () => {} }; },
      connectCodex: async (e) => {
        events = e;
        return { call: async () => ({ data: [] }), notify: () => {}, close: () => {} };
      },
    });
    await until(() => { expect(events).toBeDefined(); });

    // The 401 shape: the reason arrives on `error`, the death arrives as an abort.
    events!.onNotify('error', {
      threadId: 'T1', turnId: 'u1', willRetry: false,
      error: { message: 'unexpected status 401 Unauthorized' },
    });
    events!.onNotify('turn/completed', { threadId: 'T1', turn: { status: 'interrupted', error: null } });

    await until(() => {
      expect(sent.some((t) => t.includes('Codex turn failed: unexpected status 401 Unauthorized'))).toBe(true);
    });
    expect(sent.find((t) => t.includes('Codex turn failed'))).toContain('\u26a0\ufe0f');

    // The daemon log is shared by every session on the machine, so it carries
    // identity and outcome only — never card text. This is not hypothetical:
    // the first version logged the whole failure message and a real 503 from a
    // provider put a private relay endpoint into the log.
    const logged = logLines.join('\n');
    expect(logged).toContain('codex.turn.failed');
    expect(logged).toContain('"delivered":true');
    expect(logged).not.toContain('401 Unauthorized');
    } finally { logSpy.mockRestore(); }
  });

  it('a retryable Codex error never reaches IM', async () => {
    const sent: string[] = [];
    const adapter: IMAdapter = {
      channel: 'telegram',
      async start() {}, async stop() {},
      async send(out: OutgoingMessage) { if (out.kind === 'text') sent.push(out.text); return { messageId: 'm1' }; },
      async edit() {}, onInbound() {}, isConnected() { return 'connected' as const; },
    };
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    let events: CodexRpcEvents | undefined;
    h = await bootstrapDaemon({
      home: tmp,
      imAdapters: [adapter],
      // Reports running like a real adopted custody does — that report is what
      // starts the companion now, so a fake that stays silent means no companion.
      ensureAppServer: async (o: any) => { o.onStateChange?.('running'); return { adopted: true, stop: () => {} }; },
      connectCodex: async (e) => {
        events = e;
        return { call: async () => ({ data: [] }), notify: () => {}, close: () => {} };
      },
    });
    await until(() => { expect(events).toBeDefined(); });

    events!.onNotify('error', { threadId: 'T2', turnId: 'u1', willRetry: true, error: { message: 'websocket 401, retrying' } });
    events!.onNotify('turn/completed', { threadId: 'T2', turn: { status: 'interrupted', error: null } });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((t) => t.includes('Codex turn failed'))).toHaveLength(0);
  });

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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'touch /x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(notes).toHaveLength(1); }); // exactly once — not once per configured channel
    expect(notes[0].title).toBe('w · approval needed');
    expect(notes[0].body).toBe('Bash · touch /x'); // the call itself, so you know what you are being called about
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
    expect(notes).toHaveLength(1); // answering fires nothing further, and retracts nothing
  });

  // detectLang wired all the way through bootstrap: the outer beforeEach
  // already clears LC_ALL/LC_MESSAGES/LANG, so this only needs to state its
  // own intent explicitly — a bare C/POSIX environment, no locale at all.
  it('renders the held reason in English under a C/POSIX locale (detectLang wired through bootstrap)', async () => {
    process.env.LC_ALL = 'C';
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } }, // an answer surface, or the router defers instead of holding
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(notes).toHaveLength(1); });
    expect(notes[0].title).toBe('w · approval needed');
    expect(notes[0].body).toBe('Bash · ls'); // the project name and the tool are never translated
  });

  it('the desktop notification is immediate — it does NOT wait out the IM card grace delay (the local user is the whole point)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 30 }, // IM card held back 30s…
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(notes).toHaveLength(1); });
    expect(sent).toHaveLength(0); // …but the desktop already knows
    // Local answer within grace (PostToolUse cancel) → the card is never sent.
    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await pending;
    expect(sent).toHaveLength(0);
  });

  it('two configured chats with a slow adapter still get ONE desktop notification per request (regression: per-chat concurrent pushes each fired one)', async () => {
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [tg, fs], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'touch /x' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await until(() => { expect(sent).toHaveLength(2); }); // one card per channel…
    expect(notes).toHaveLength(1); // …but a single desktop notification
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    tg.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
  });

  it('a finished turn does NOT pop a desktop notification (per-turn completion would flood) — it stays on IM only', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    // Drive the real, shared continueBroker directly (same instance the CC Stop
    // and Codex turn/completed paths both funnel through). Floating request with
    // a tiny window; we only assert the notification surfaces, not the reply.
    void h.continueBroker.request({ cwd: '/w', context: 'Finished building the feature', timeoutSec: 1 });
    await until(() => { expect(sent).toHaveLength(1); }); // …still surfaced on IM
    expect(renders).toHaveLength(0); // no desktop flood on completion…
    expect((sent[0] as { title?: string }).title).toContain('Turn finished');
  });

  // 2026-08-14 left a 121MB daemon.log on this machine, 95% of it one repeated
  // line. The loop that wrote it is fixed; the reason it could cost 115MB is
  // not, and that is the part that generalises to the next flood.
  it('a daemon.log past the cap is truncated at startup, newest lines kept', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const logPath = join(tmp, 'daemon.log');
    const line = (n: number) => `{"ts":"2026-08-19T00:00:00.000Z","level":"info","msg":"noise ${n}"}\n`;
    // Deliberately past the REAL cap rather than injecting a test-only one:
    // the constant is part of what is being checked.
    writeFileSync(logPath, Array.from({ length: 260_000 }, (_, i) => line(i)).join(''));
    const before = statSync(logPath).size;
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async () => {} } });
    const after = readFileSync(logPath, 'utf8');
    expect(statSync(logPath).size).toBeLessThan(before);
    expect(after).toContain('"msg":"noise 259999"');
    expect(after).not.toContain('"msg":"noise 0"');
  });

  // Every IM flood this project has had came from a push that skipped the
  // grace. The approval card waits ten seconds of silence, the continue card
  // waits fifteen, and neither has ever flooded anyone. A dead turn was pushed
  // immediately, and produced eight identical lines in forty-six minutes on a
  // real machine. The grace is not a rate limit — it is how tlive detects that
  // you are not here: if the session came back on its own, nobody needed
  // telling in the first place.
  describe('a turn that died reaches IM only if it is still dead when the grace ends', () => {
    const DEAD = { kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'error' as const,
      message: 'session error: server_error', sessionError: { text: 'server_error', transient: true } };

    it('the session came back inside the grace → nobody hears about it', async () => {
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({
        web: { enabled: false }, approvals: { continueGraceSec: 2 },
        adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
      }));
      const sent: OutgoingMessage[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)], desktopNotifier: { notify: async () => {} } });
      const sock = daemonSocketPath(tmp);
      await request(DEAD, { socketPath: sock, timeoutMs: 2000 });
      // A new prompt is the session coming back — the same signal that cancels
      // a continue card's grace.
      await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/w', sessionId: 's1', prompt: 'carry on' } }, { socketPath: sock, timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, 2400));
      expect(sent).toHaveLength(0);
    });

    it('the session stayed dead → one line, carrying the reason', async () => {
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({
        web: { enabled: false }, approvals: { continueGraceSec: 1 },
        adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
      }));
      const sent: OutgoingMessage[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)], desktopNotifier: { notify: async () => {} } });
      const sock = daemonSocketPath(tmp);
      await request(DEAD, { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(sent).toHaveLength(1); });
      expect((sent[0] as { text?: string }).text).toContain('server_error');
    });
  });

  // Real machine, 2026-09-02 01:29–01:31Z. One account-level rate limit killed
  // six background agents at once. Every dead turn fires its own StopFailure,
  // and StopFailure carries no `agent_id` at all — Claude Code stamps it with
  // the MAIN session id — so one condition arrived as twenty-five identical
  // reports against one session key: twenty-four desktop toasts and eight
  // Telegram lines in two and a half minutes.
  //
  // The grace was never the wrong idea, it was asking the wrong question.
  // "Did the session come back?" is a question about ONE death, and it was
  // being asked N times in parallel through a single-slot map, where each
  // event's timer deleted whichever event's entry happened to be in the slot.
  // Nothing anywhere asked the question that actually matters once a session
  // can die more than once: have we already said this?
  describe('one dead session says it once, however many agents died with it', () => {
    const dead = (text: string, transient = false) => ({
      kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'error' as const,
      message: `session error: ${text}`, sessionError: { text, transient },
    });
    const imConfig = (graceSec: number) => JSON.stringify({
      web: { enabled: false }, approvals: { continueGraceSec: graceSec },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    });
    /** Desktop renders for a dead turn only. `shouldFastNullContinue` also
     *  pops a "waiting for your input" toast, which is a different event. */
    const deaths = (renders: Array<{ title: string; body: string }>) =>
      renders.filter((r) => r.title.includes('turn failed'));

    // Staggered, not a burst, because that is what the machine did: the agents
    // finished one at a time ("Waiting for 5 background agents to finish"), so
    // the deaths straddled grace boundaries instead of arriving inside one.
    // A burst alone does not discriminate — the old single-slot map happened to
    // deliver exactly one of six that way, by losing the other five rather than
    // by collapsing them.
    it('six agents die on one rate limit → one IM line, not six', async () => {
      writeFileSync(join(tmp, 'config.json'), imConfig(1));
      const sent: OutgoingMessage[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)], desktopNotifier: { notify: async () => {} } });
      const sock = daemonSocketPath(tmp);
      for (let i = 0; i < 6; i++) {
        await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
        await new Promise((r) => setTimeout(r, 400));
      }
      await until(() => { expect(sent).toHaveLength(1); });
      expect((sent[0] as { text?: string }).text).toContain('rate_limit');
      // Past the grace of the LAST death, so a second line would have landed.
      await new Promise((r) => setTimeout(r, 1400));
      expect(sent).toHaveLength(1);
    });

    it('six agents die on one rate limit → one desktop toast, not six', async () => {
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { continueGraceSec: 1 } }));
      const renders: Array<{ title: string; body: string }> = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
      const sock = daemonSocketPath(tmp);
      for (let i = 0; i < 6; i++) await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(deaths(renders)).toHaveLength(1); });
      expect(deaths(renders)[0]!.body).toContain('rate_limit');
      await new Promise((r) => setTimeout(r, 1400));
      expect(deaths(renders)).toHaveLength(1);
    });

    // A session limit stands for hours. Every turn attempted against it dies
    // the same way, spaced far wider than any grace — which is why the grace
    // alone cannot hold this line.
    it('the same failure, long after it was reported, is not news', async () => {
      writeFileSync(join(tmp, 'config.json'), imConfig(1));
      const sent: OutgoingMessage[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)], desktopNotifier: { notify: async () => {} } });
      const sock = daemonSocketPath(tmp);
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(sent).toHaveLength(1); });
      await new Promise((r) => setTimeout(r, 1200));
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, 1400));
      expect(sent).toHaveLength(1);
    });

    // Silence is only earned while the condition stands. A different error is
    // a different condition and has never been reported.
    it('a different failure is still news', async () => {
      writeFileSync(join(tmp, 'config.json'), imConfig(1));
      const sent: OutgoingMessage[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)], desktopNotifier: { notify: async () => {} } });
      const sock = daemonSocketPath(tmp);
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(sent).toHaveLength(1); });
      await new Promise((r) => setTimeout(r, 1200));
      await request(dead('billing_error — Credit balance too low'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(sent).toHaveLength(2); });
      expect((sent[1] as { text?: string }).text).toContain('billing_error');
    });

    // What ends the episode: a turn that actually finished. A turn that dies
    // fires StopFailure and no Stop, so a continue request is proof the
    // session is working again — and the next death is a new condition.
    it('a turn that finished ends the episode — the next death is news again', async () => {
      // No IM chat and no dashboard client ⇒ the continue request returns
      // immediately instead of holding its window open.
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { continueGraceSec: 1 } }));
      const renders: Array<{ title: string; body: string }> = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
      const sock = daemonSocketPath(tmp);
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(deaths(renders)).toHaveLength(1); });
      await request({ kind: 'hook.continue.request', cwd: '/w', sessionId: 's1', context: 'ctx', lastMessage: 'done' }, { socketPath: sock, timeoutMs: 4000 });
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(deaths(renders)).toHaveLength(2); });
    });

    // Re-arming must not become swallowing. In the real trace the deaths were
    // interleaved with events that cancel a pending report, and a fix that
    // only ever collapsed would have turned twenty-five reports into none.
    it('a death that lands after the session came back is still reported', async () => {
      writeFileSync(join(tmp, 'config.json'), imConfig(1));
      const sent: OutgoingMessage[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)], desktopNotifier: { notify: async () => {} } });
      const sock = daemonSocketPath(tmp);
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await request({ kind: 'hook.event', event: { event: 'prompt', cwd: '/w', sessionId: 's1', prompt: 'carry on' } }, { socketPath: sock, timeoutMs: 2000 });
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(sent).toHaveLength(1); });
      expect((sent[0] as { text?: string }).text).toContain('rate_limit');
    });

    // A mute is not a report. The latch means "you have been told", so a send
    // that told nobody must not claim it — otherwise unmuting leaves you quiet
    // about a condition that is still standing.
    it('a mute does not burn the report — it is still there when you unmute', async () => {
      writeFileSync(join(tmp, 'config.json'), imConfig(1));
      const sent: OutgoingMessage[] = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)], desktopNotifier: { notify: async () => {} } });
      const sock = daemonSocketPath(tmp);
      await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 });
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, 1400));
      expect(sent).toHaveLength(0);
      await request({ kind: 'daemon.set', key: 'mute', enabled: false }, { socketPath: sock, timeoutMs: 2000 });
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(sent).toHaveLength(1); });
    });

    // The session going away ends it too — and leaves nothing behind, which is
    // the difference between a cache and a leak.
    it('a session that ended leaves no latch behind', async () => {
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { continueGraceSec: 1 } }));
      const renders: Array<{ title: string; body: string }> = [];
      h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
      const sock = daemonSocketPath(tmp);
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(deaths(renders)).toHaveLength(1); });
      await request({ kind: 'hook.event', event: { event: 'session-end', cwd: '/w', sessionId: 's1' } }, { socketPath: sock, timeoutMs: 2000 });
      await request(dead('rate_limit'), { socketPath: sock, timeoutMs: 2000 });
      await until(() => { expect(deaths(renders)).toHaveLength(2); });
    });
  });

  // Claude Code restates "the turn ended" sixty seconds later as its own
  // notification. tlive already reported that event, as a card you can answer.
  // A restatement is not a second event, so it does not go to IM — and because
  // nothing info-level does any more, there is no dedupe flag to get wrong when
  // a new path appears. That flag existed, keyed on the Stop hook, and missed
  // exactly the path where the Stop hook never runs.
  it("Claude Code's own idle text never reaches IM, with or without a card having gone out", async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false }, approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [interactiveAdapter('telegram', sent)], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 250));
    expect(sent).toHaveLength(0);
  });

  it('an info-level notify no longer reaches the desktop, and a failed tool never did', async () => {
    // Claude Code's own 60-second "waiting for your input" notification used to
    // be this channel's trigger; "your turn" rides the Stop hook now. A failed
    // tool stays excluded: it blocks nobody — the agent recovers from it on its
    // own turn — and it goes to the dashboard where it is diagnosable.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'error', message: 'Bash failed: boom' }, { socketPath: sock, timeoutMs: 2000 });
    expect(renders).toHaveLength(0);
  });

  // A turn that died on something no retry fixes is the one failure that DOES
  // reach the desktop: nothing further will happen in that session until a
  // human deals with it, which is the same "nothing happens until you come
  // back" that earns a finished turn its notification.
  it('a session error nothing retries its way out of pops a desktop notification', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({
      kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'error',
      message: 'session error: billing_error — Credit balance too low',
      sessionError: { text: 'billing_error — Credit balance too low', transient: false },
    }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(renders).toHaveLength(1); });
    expect(renders[0]!.body).toContain('billing_error');
  });

  // The common case on a real machine: every API error observed here was
  // `server_error` behind "Connection lost mid-response" — the session picks up
  // where it left off. Ringing a desktop bell for those is the flood the
  // per-event channel exists to avoid.
  it('a transient session error stays off the desktop — the session recovers on its own', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({
      kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'error',
      message: 'session error: server_error',
      sessionError: { text: 'server_error', transient: true },
    }, { socketPath: sock, timeoutMs: 2000 });
    expect(renders).toHaveLength(0);
  });

  // "Your turn" rides the Stop hook, the same event the IM continue card rides,
  // and NOT Claude Code's own 60-second "waiting for your input" notification.
  // Two reasons, both structural: the Stop hook's payload carries the real last
  // assistant message, whereas the notification path had to dig it out of a
  // registry field that the same hook overwrites with its own boilerplate; and
  // the timing then belongs to tlive's own configurable grace instead of a
  // Claude Code constant that varies with the user's settings.
  it('a session that ends inside the grace announces nothing — there is nobody left to call back', async () => {
    // A ONE-SECOND grace, and the wait runs past it: an absence assertion needs
    // the window it is denying to have actually elapsed.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { continueGraceSec: 1, continueWindowSec: 60 } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    void request(
      { kind: 'hook.continue.request', cwd: '/w/repo', sessionId: 's1', context: 'ctx', lastMessage: 'done' },
      { socketPath: sock, timeoutMs: 40_000 },
    ).catch(() => undefined);
    await request({ kind: 'hook.event', event: { event: 'session-end', cwd: '/w/repo', sessionId: 's1' } }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(renders).toHaveLength(0);
  });

  it('a tool call inside the grace does NOT cancel the announcement — it is the finished turn trailing, not you coming back', async () => {
    // The cancel rule is deliberately narrow: only a prompt or a session end.
    // Keying it on any activity would be one event-ordering change away from
    // silently killing every announcement, since a turn's own trailing events
    // can land inside its grace — Codex sends the turn/completed attention
    // event before the grace even starts.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { continueGraceSec: 1, continueWindowSec: 60 } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    void request(
      { kind: 'hook.continue.request', cwd: '/w/repo', sessionId: 's1', context: 'ctx', lastMessage: 'done' },
      { socketPath: sock, timeoutMs: 40_000 },
    ).catch(() => undefined);
    // Inside the grace, and it must not count as you coming back.
    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/w/repo', sessionId: 's1', toolName: 'Bash' } }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(renders).toHaveLength(1); });
  });

  it('a finished turn notifies the desktop with what Claude actually said', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { continueGraceSec: 0, continueWindowSec: 30 } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    // The Stop hook blocks in the daemon until the continue window resolves, so
    // it cannot be awaited here.
    void request(
      { kind: 'hook.continue.request', cwd: '/w/repo', sessionId: 's1', context: 'ctx', lastMessage: 'Fixed the retry path; 932 tests pass' },
      { socketPath: sock, timeoutMs: 40_000 },
    ).catch(() => undefined);
    await until(() => { expect(renders).toHaveLength(1); });
    expect(renders[0].title).toBe('repo · waiting for your input');
    expect(renders[0].body).toBe('Fixed the retry path; 932 tests pass');
  });

  it('Claude Code\'s own 60-second idle notification no longer produces a desktop notification — one event, one notification', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    expect(renders).toHaveLength(0);
  });

  // The reason is localized inside renderWaiting, and the test above cannot tell
  // that apart from a hardcoded English literal, since 'en' is this suite's
  // default. This one forces zh and checks the TITLE actually switches — proving
  // `lang` is threaded from detectLang to the emit site rather than fixed.
  it('a finished turn\'s reason is localized to zh under a zh locale, not hardcoded English', async () => {
    process.env.LC_ALL = 'zh_CN.UTF-8';
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { continueGraceSec: 0, continueWindowSec: 30 } }));
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { renders.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    void request(
      { kind: 'hook.continue.request', cwd: '/w', sessionId: 's1', context: 'ctx', lastMessage: 'done' },
      { socketPath: sock, timeoutMs: 40_000 },
    ).catch(() => undefined);
    await until(() => { expect(renders).toHaveLength(1); });
    expect(renders[0].title).toContain('等你输入');
    expect(renders[0].title).not.toContain('your input');
  });

  it('the desktop channel is INDEPENDENT of IM mute (IM ⊥ desktop): /mute on silences IM but a finished turn still notifies the desktop', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { continueGraceSec: 0, continueWindowSec: 30 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const renders: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (t, b) => { renders.push({ title: t, body: b }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 }); // /mute on
    void request(
      { kind: 'hook.continue.request', cwd: '/w', sessionId: 's1', context: 'ctx', lastMessage: 'done' },
      { socketPath: sock, timeoutMs: 40_000 },
    ).catch(() => undefined);
    await until(() => { expect(renders).toHaveLength(1); }); // desktop fires despite the IM mute…
    expect(sent).toHaveLength(0);  // …IM stays silent
  });

  it('a notify for a session the daemon has never seen still carries the "<label> · " tag — first contact must not render before the session is registered', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false }, approvals: { continueGraceSec: 1 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter] });
    const sock = daemonSocketPath(tmp);
    // Mirrors a daemon restart: the registry is empty, and this notify is the
    // FIRST thing the daemon ever hears about this session (started earlier).
    // Driven by a dead turn because that is the only thing this handler still
    // sends to IM — the label question is the same either way.
    expect(h.sessions.get('s-unseen')).toBeUndefined();
    await request({
      kind: 'hook.notify', cwd: '/unseen-project', sessionId: 's-unseen', level: 'error',
      message: 'session error: billing_error', sessionError: { text: 'billing_error', transient: false },
    }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(sent).toHaveLength(1); });
    expect((sent[0] as { kind: 'text'; text: string }).text.startsWith('unseen-project · ')).toBe(true);
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
  // onPending's notification also renders sessionLabel(key) — and used to do so
  // BEFORE its own final `sessions.upsert(...)` registered the session, so a
  // session's very first tool-permission request (e.g. right after a daemon
  // restart) went out unlabelled.
  it('the first-ever permission request for a never-before-seen session still carries the "<label> · " prefix (onPending)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      web: { enabled: false },
      approvals: { approvalGraceSec: 0 },
      adapters: { telegram: { token: 't', chatIdAllowList: ['c1'] } },
    }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
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

  it('the Codex path reaches the shared broker and the IM card, carrying the assistant\'s message', async () => {
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
      gracePassed: async () => true,
      notifyTurn: () => {}
    });

    // This used to pass no lastMessage, and asserted that an EMPTY card went out.
    // That behaviour is now suppressed: an interrupted turn produces no assistant
    // message, and announcing it sent nine empty cards in fourteen minutes on
    // real hardware. The empty-body RENDERING is still covered, at the level it
    // belongs to — see continue-card.test.ts's `buildContinueCardBody('')` case.
    // What this test is for is the wiring: Codex reaches the shared broker, whose
    // onRequest handler builds the IM card.
    onCodexResumePrompt({ threadId: 't1', key: 'codex:t1', lastMessage: 'patch applied' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(sent).toHaveLength(1);
    const card = sent[0] as { kind: 'card'; title?: string; body?: string };
    expect(card.title?.endsWith('Turn finished')).toBe(true);
    expect(card.body).toContain('patch applied');
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
  // sub-agent used to produce NO signal at all. The desktop channel is
  // precisely the "at this machine, not watching the terminal" one.
  it('fires ONE desktop notification naming the tool when a sub-agent request passes through', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );

    await until(() => { expect(notes).toHaveLength(1); });
    // The reason says it is a sub-agent's; the body says which call is blocked.
    // Neither names a place to answer: renderWaiting cannot tell a terminal-only
    // dialog from a remotely answerable one (see waiting-notice.ts's REASON doc).
    expect(notes[0].title).toBe('w · sub-agent needs approval');
    expect(notes[0].body).toBe('Bash · rm -rf /tmp/scratch');
  });

  // Same call-site-ordering bug as onPending above, the other flagged site:
  // onPassthrough's notification also renders sessionLabel(key) before its own
  // guarded upsert registered the session, so a sub-agent's first-ever
  // pass-through (e.g. right after a daemon restart) went out unlabelled.
  it('a sub-agent pass-through for a never-before-seen session still carries the "<label> · " prefix', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
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
  it('IM mute silences the card, but the desktop notification still fires (IM ⊥ desktop)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
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
  // (agentId, toolName) pair) must clear the read-only dashboard card — that
  // card is now the ONLY surface that says what is waiting right now, so a
  // notice that never retires is a card still claiming a dialog nobody is
  // looking at.
  it('a matching PostToolUse clears the read-only dashboard card', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request(
      {
        kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', agentId: 'a-77',
        toolName: 'Bash', input: { command: 'rm -rf /tmp/scratch' }, timeoutSec: 60,
      },
      { socketPath: sock, timeoutMs: 5000 },
    );
    await until(() => { expect(notes).toHaveLength(1); });
    expect((await findSession(sock, 's1'))?.pending?.local).toBe(true);

    await request(
      { kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', agentId: 'a-77', toolName: 'Bash', result: {} } },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await until(async () => { expect((await findSession(sock, 's1'))?.pending).toBeUndefined(); });
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

  // The posture gate below this one exists because in a holding rung tlive has
  // already seen the request — held it, or handed it back with a notice that
  // carries more than this event does. That reasoning is true of permission
  // dialogs and FALSE of everything else that blocks: there is no
  // PermissionRequest behind an MCP elicitation dialog, and Claude Code does not
  // dispatch one for a teammate's forwarded request at all, so tlive cannot have
  // held either. For those, this notice is the only signal that exists, at every
  // rung.
  it('a question notice reaches the machine even in a holding rung — tlive never held one of those', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'full' }));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude Code needs your input', localWaiting: 'question' }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('Claude Code needs your input');
    const s = await findSession(sock, 's1');
    expect(s?.pending?.local).toBe(true);
  });

  // A teammate's approval is worded like an approval and gated like a blocked
  // notice, because those are two different questions: "what do I call this?"
  // and "might tlive already be holding a card for it?". Claude Code never
  // dispatches PermissionRequest for a teammate's forwarded request, so the
  // answer to the second is always no — folding it in with ordinary approvals
  // would drop it in exactly the rungs where someone is most likely away.
  it("a teammate's relayed approval reaches the machine in a holding rung, and still reads as an approval", async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'all' }));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'agent-7 needs permission for Bash', localWaiting: 'relayed-approval' }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('w · approval needed');
    expect(notes[0].body).toBe('agent-7 needs permission for Bash');
  });

  // `agent_needs_input` is stamped with the WATCHING session's id and cwd — the
  // notification is emitted by whoever is displaying the agent list, while the
  // thing that is stuck is a background job with its own session id. The toast
  // is still worth sending, because Claude Code's own sentence names the agent
  // and says what it needs. A dashboard card is not: it would put this session
  // into waiting-approval, which is a claim about a session that is not blocked.
  it('a notice about some OTHER agent rings the desktop but does not claim THIS session is blocked', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'nightly-build needs your input: login required — run /login', localWaiting: 'elsewhere' }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('login required');
    const s = await findSession(sock, 's1');
    expect(s?.pending).toBeFalsy();
    expect(s?.status).not.toBe('waiting-approval');
  });

  // The dashboard picks its badge word from the session status, and every one of
  // these notices sets `waiting-approval` — which is the right RANK, since all
  // of them are genuinely blocked, but the wrong WORD for a question. An
  // elicitation dialog came out with a card titled "Needs your answer" sitting
  // next to a badge that said "approve": one card, two claims, and they
  // disagreed. The kind travels with the pending so the badge can say what the
  // card says without the frontend guessing from the title string.
  it('a question card is labelled as one, and an approval as one', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 'q1', level: 'info', message: 'Claude Code needs your input', localWaiting: 'question' }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 'a1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });

    expect((await findSession(sock, 'q1'))?.pending?.answerKind).toBe('answer');
    expect((await findSession(sock, 'a1'))?.pending?.answerKind).toBe('approve');
  });

  // The other half of the same rule: an approval notice in a holding rung stays
  // suppressed, because there the card owns every surface already.
  it('an approval notice in a holding rung stays suppressed', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'full' }));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(0);
  });

  // The one-time IM card exists to say "these become answerable on `full`". That
  // is true of a permission dialog and FALSE of everything else that blocks: no
  // rung of the ladder can make an MCP elicitation dialog or a teammate's
  // forwarded request answerable from a phone, because tlive is never offered
  // the chance to hold either. Sending it here would spend a once-per-chat card
  // on a promise the product cannot keep.
  it('a question notice never spends the one-time "switch to full" card', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: 'Claude Code needs your input', localWaiting: 'question' }, { socketPath: sock, timeoutMs: 2000 });
    expect(sent).toHaveLength(0);

    // …and it is still unspent, so the next real approval still gets it.
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    await until(() => { expect(sent).toHaveLength(1); });
  });

  // Same chain, different sentence. "approval needed" over an elicitation dialog
  // is a small lie, and this project keeps paying for those.
  it('the two kinds do not read the same on the desktop', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's2', level: 'info', message: 'x needs your input', localWaiting: 'question' }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe('w · approval needed');
    expect(notes[1].title).not.toBe(notes[0].title);
  });

  it('no held request → desktop notification + read-only waiting-approval card; IM gets the one-time notify explanation, not dead mail (the chain a silent hang used to be)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });

    // Desktop: one notification, speaking to the person at the machine. CC's
    // Notification carries no tool name and no agent id, so its own sentence is
    // the only thing there is to say what is waiting.
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('w · approval needed');
    expect(notes[0].body).toBe(MSG);
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
  it('full mode: a permission_prompt with nothing held creates no card, notification or IM text', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'full' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });

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
  it('all mode: a permission_prompt with nothing held ALSO creates no card, notification or IM text', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'all' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });

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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    writeMode(tmp, 'notify');

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });

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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w/api', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((m) => (m as { text?: string }).text?.includes('answer in the terminal'))).toHaveLength(0);
  });

  it('the first suppressed dialog explains itself once per chat, with a way out', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w/api', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    await waitForSent(sent);
    expect(sent).toHaveLength(1);
    const card = sent[0] as { buttons?: Array<{ id: string }> };
    expect(card.buttons?.map((b) => b.id)).toContain('mode:full');

    // A second, unrelated session hits the same suppressed-dialog path —
    // same chat, so the explanation must not repeat.
    await request({ kind: 'hook.notify', cwd: '/w/api2', sessionId: 's2', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w/api', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    await vi.waitFor(() => {
      expect(logs.some((l) => l.includes('permission.localPrompt.im.undelivered'))).toBe(true);
    }, { timeout: 2000, interval: 10 });
    const entry = JSON.parse(logs.find((l) => l.includes('permission.localPrompt.im.undelivered'))!) as { error?: string };
    expect(entry.error).toContain('boom');
    logSpy.mockRestore();

    // The flag is still burned even though delivery failed — mark-before-send
    // means a retry (e.g. unmuting later) is a NEW state, not a resend of this
    // same failed attempt (a second dialog for the same chat stays quiet).
    await request({ kind: 'hook.notify', cwd: '/w/api2', sessionId: 's2', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.filter((l) => l.includes('permission.localPrompt.im.undelivered'))).toHaveLength(1);
  });

  it('the explanation survives a daemon restart — "once" means once, not once per boot', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify' }));
    const sent: OutgoingMessage[] = [];
    const boot = async (): Promise<void> => {
      const adapter = interactiveAdapter('telegram', sent);
      h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
      await request({ kind: 'hook.notify', cwd: '/w/api', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: daemonSocketPath(tmp), timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, 50));
      await h.shutdown();
    };
    await boot();
    await boot();
    expect(sent).toHaveLength(1);
  });

  it('Claude Code\'s idle notification does NOT reach IM once the Stop hook announced this turn — the continue card already said it', async () => {
    // The old dedup asked "is a continue card live", reading a field that is
    // only written after the grace and never written at all when the grace
    // cancels the card — so the notification slipped through the very window
    // the rule exists to cover. It now asks "was this turn's end announced",
    // which the Stop hook's arrival settles before any grace runs.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, mode: 'notify', approvals: { continueGraceSec: 30, continueWindowSec: 60 } }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);
    void request(
      { kind: 'hook.continue.request', cwd: '/w/vf', sessionId: 's1', context: 'ctx', lastMessage: 'done' },
      { socketPath: sock, timeoutMs: 40_000 },
    ).catch(() => undefined);
    // Still inside the grace: no card has been sent yet, and the old rule would
    // have let this through.
    await request({ kind: 'hook.notify', cwd: '/w/vf', sessionId: 's1', level: 'info', message: 'Claude is waiting for your input' }, { socketPath: sock, timeoutMs: 2000 });
    expect(sent.filter((m) => (m as { text?: string }).text?.includes('waiting for your input'))).toHaveLength(0);
  });



  it('a held request for the same session already owns every surface → the notification is dropped (full-mode dedupe)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    const pending = request(
      { kind: 'hook.permission.request', cwd: '/w', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, timeoutSec: 60 },
      { socketPath: sock, timeoutMs: 10_000 },
    );
    held(pending);
    await waitForSent(sent); // card out ⇒ pending registered, onPending ping fired
    expect(notes).toHaveLength(1);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });

    expect(notes).toHaveLength(1); // no second notification
    expect(sent).toHaveLength(1); // no extra IM text — the card owns IM
    const s = await findSession(sock, 's1');
    expect(s?.pending?.local).toBeUndefined(); // still the answerable card
    const card = sent[0] as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    adapter.fire({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'x1', text: card.buttons!.find((b) => b.id.startsWith('approve:'))!.id, ts: 0 });
    await pending;
  });

  // The IM text this test's name used to protect is gone (dead mail). What
  // survives: a local answer still retires the tracked dialog (the registry's
  // read-only pending goes away) — and the one-time explain card, which fires
  // immediately rather than riding any grace, is unaffected by that retirement
  // (it isn't per-dialog, so there's nothing for the local answer to cancel).
  it('a local answer (main-session PostToolUse) retires the chain: pending gone — the one-time explain card is unaffected (it fires immediately, not gated by grace)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ ...CFG, approvals: { approvalGraceSec: 30 } }));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    expect((await findSession(sock, 's1'))?.status).toBe('waiting-approval');
    await waitForSent(sent); // the one-time explanation card, sent immediately
    expect(sent).toHaveLength(1);

    await request({ kind: 'hook.event', event: { event: 'activity', cwd: '/w', sessionId: 's1', toolName: 'Bash', result: {} } }, { socketPath: sock, timeoutMs: 2000 });

    const s = await findSession(sock, 's1');
    expect(s?.status).toBe('active');
    expect(s?.pending).toBeUndefined();
    expect(sent).toHaveLength(1); // still just the one explanation — nothing new fires on retire
  });

  it('sub-agent activity does NOT retire the main-session dialog tracking (parallel agents keep running while you look at the dialog)', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(CFG));
    const sent: OutgoingMessage[] = [];
    const adapter = interactiveAdapter('telegram', sent);
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });

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
    h = await bootstrapDaemon({ home: tmp, imAdapters: [adapter], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);

    await request({ kind: 'daemon.set', key: 'mute', enabled: true }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w', sessionId: 's1', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toHaveLength(0); // muted → suppressed, not sent, not marked explained

    await request({ kind: 'daemon.set', key: 'mute', enabled: false }, { socketPath: sock, timeoutMs: 2000 });
    await request({ kind: 'hook.notify', cwd: '/w2', sessionId: 's2', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    await waitForSent(sent);
    expect(sent).toHaveLength(1); // now unmuted — the explanation they never got still arrives, once
    const card = sent[0] as { buttons?: Array<{ id: string }> };
    expect(card.buttons?.map((b) => b.id)).toContain('mode:full');

    // A third suppressed-dialog session, same chat, must not repeat it.
    await request({ kind: 'hook.notify', cwd: '/w3', sessionId: 's3', level: 'info', message: MSG, localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
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

// The desktop channel is a stream of events: each of the four places that
// knows something started waiting fires ONE notification naming the project and
// the call, and nothing ever retracts, replaces or re-renders it. "What is
// waiting right now" belongs to the dashboard, which is a pull view built for
// it.
describe('desktop notifications are one-per-event', () => {
  it('a CC-native dialog fires exactly one notification naming the project', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w/repo', sessionId: 's1', level: 'info', message: 'Claude needs your permission to use Bash', localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('repo · approval needed');
    expect(notes[0]!.body).toBe('Claude needs your permission to use Bash');
  });


  it('a read-only dialog card is timestamped, so the dashboard can say WHEN it was reported instead of asserting it is still true', async () => {
    // tlive cannot know whether a Claude Code dialog is still up: the
    // notification that reports one carries no agent id, so a dialog raised by
    // a background agent is recorded against the main session and answered by a
    // tool call the clearing path deliberately ignores. Rather than guess — and
    // clearing on sub-agent activity would wipe a main dialog that really is
    // waiting, measured at 27 minutes on real hardware — the claim carries the
    // moment it was made and the dashboard renders its age.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async () => {} } });
    const sock = daemonSocketPath(tmp);
    const before = Date.now();
    await request({ kind: 'hook.notify', cwd: '/w/repo', sessionId: 's1', level: 'info', message: 'Claude needs your permission to use Bash', localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    const seenAt = h.sessions.get('s1')?.pending?.seenAt;
    expect(typeof seenAt).toBe('number');
    expect(seenAt!).toBeGreaterThanOrEqual(before);
    expect(seenAt!).toBeLessThanOrEqual(Date.now());
  });

  it('answering fires NOTHING — retirement events have no desktop surface any more', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w/repo', sessionId: 's1', level: 'info', message: 'Claude needs your permission to use Bash', localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    expect(notes).toHaveLength(1);
    for (const ev of [
      { event: 'activity' as const, cwd: '/w/repo', sessionId: 's1', toolName: 'Bash' },
      { event: 'prompt' as const, cwd: '/w/repo', sessionId: 's1' },
      { event: 'permission-denied' as const, cwd: '/w/repo', sessionId: 's1', toolName: 'Bash' },
      { event: 'session-end' as const, cwd: '/w/repo', sessionId: 's1' },
    ]) {
      await request({ kind: 'hook.event', event: ev }, { socketPath: sock, timeoutMs: 2000 });
    }
    expect(notes).toHaveLength(1); // still one: nothing retracts, nothing re-renders
  });

  it('error-level notify still never reaches the desktop — a failed tool is not blocking anyone', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w/repo', sessionId: 's1', level: 'error', message: 'Bash failed: boom' }, { socketPath: sock, timeoutMs: 2000 });
    expect(notes).toHaveLength(0);
  });

  it('zh locale: the reason is localized, the project name and tool are not', async () => {
    process.env.LC_ALL = 'zh_CN.UTF-8';
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    const notes: Array<{ title: string; body: string }> = [];
    h = await bootstrapDaemon({ home: tmp, imAdapters: [], desktopNotifier: { notify: async (title, body) => { notes.push({ title, body }); } } });
    const sock = daemonSocketPath(tmp);
    await request({ kind: 'hook.notify', cwd: '/w/repo', sessionId: 's1', level: 'info', message: 'Claude needs your permission to use Bash', localWaiting: 'approval' }, { socketPath: sock, timeoutMs: 2000 });
    expect(notes[0]!.title).toBe('repo · 等你批准');
  });
});

// Regression guard for the old `desktopOn && webUrl != null`: whether a desktop
// notification was fired says nothing about whether the dashboard can answer. A
// dashboard URL alone is the local answer path — no desktop input belongs in the
// predicate at all.
describe('the local answer path is a dashboard URL alone', () => {
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

  it('a dashboard URL alone makes an approval locally answerable — no desktop input in the predicate', async () => {
    // port 0 → ephemeral; inject via config to avoid port conflicts (same
    // pattern as web-bootstrap.test.ts) — this test needs web ENABLED.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { port: 0 } }));
    const adapter = fakeAdapter();
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [adapter],
      desktopNotifier: { notify: async () => {} },
    });
    expect(h.webUrl).toBeTruthy();
    const p = h.permissionRouter.requestPermission({ key: '/w/a', cwd: '/w/a', toolName: 'Bash', input: { command: 'ls' } });
    await until(() => { expect(h.permissionRouter.pendingCount()).toBe(1); }); // held, not deferred
    h.permissionRouter.answer(firstPendingId(h), true);
    await p;
  });
});

// Task 10: the desktop channel was the one surface that left no trace at all —
// a 4.3 MB daemon.log from a real session contained zero lines matching
// `desktop|toast|notify-send`. These tests lock the two lines that make it
// observable: `desktop.channel` (factory time, covered directly in
// desktop-notify.test.ts) and `notifyDesktop`'s own `desktop.notify` per event,
// asserted here through `onLog`.
describe('the desktop channel is observable from the log alone (Task 10)', () => {
  /** Drive the idle "waiting for your input" notification the same way the CC
   *  hook layer does — a plain `hook.notify` IPC call (level: 'info', no
   *  localWaiting) — matching every other `hook.notify` call in this file,
   *  just named at this call site for readability. */
  function notifyIdle(handle: DaemonHandle, opts: { cwd: string; sessionId: string }): void {
    // The Stop hook, which is what "your turn" rides. It blocks in the daemon
    // until the continue window resolves, so it cannot be awaited — the caller
    // waits on the effect instead.
    void request(
      { kind: 'hook.continue.request', cwd: opts.cwd, sessionId: opts.sessionId, context: 'ctx', lastMessage: 'done' },
      { socketPath: handle.ipcSocketPath, timeoutMs: 40_000 },
    ).catch(() => undefined);
  }

  it('logs one line per notification, naming which kind of wait it was', async () => {
    // Identity fields only: `kind` plus the session key. The rendered title and
    // body never go to the log — they carry tool input, which can carry secrets.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false }, approvals: { continueGraceSec: 0, continueWindowSec: 30 } }));
    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { notify: async () => {} },
      onLog: (msg, fields) => { lines.push({ msg, fields }); },
    });
    notifyIdle(h, { cwd: '/w/a', sessionId: 's1' });
    await until(() => { expect(lines.some((l) => l.msg === 'desktop.notify')).toBe(true); });
    const fired = lines.filter((l) => l.msg === 'desktop.notify');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.fields).toEqual({ kind: 'idle', key: 's1' });
  });
});

// A hook session's only retirement path was SessionEnd — and kill -9, a crash,
// or a hard-closed terminal run no hooks at all. What it leaves behind is a
// registry entry: a phantom on the dashboard that IM replies still route to.
describe('a session killed without SessionEnd stops haunting the dashboard', () => {
  /** A pid that has certainly exited — spawnSync returns only after the child is
   *  reaped, so the liveness probe sees a dead process. */
  const deadPid = (): number => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    if (!pid) throw new Error('could not produce a dead pid');
    return pid;
  };

  it('reaps the session it left behind', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { notify: async () => {} },
      sweepMs: 20,
    });
    const sock = daemonSocketPath(tmp);
    const pid = deadPid();

    // The session announces itself, then goes idle.
    await request(
      { kind: 'hook.event', event: { event: 'session-start', cwd: '/ghost', sessionId: 's1' }, agentPid: pid },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await request(
      { kind: 'hook.notify', cwd: '/ghost', sessionId: 's1', level: 'info', message: 'waiting for your input', agentPid: pid },
      { socketPath: sock, timeoutMs: 2000 },
    );
    const listed = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
    expect(listed.kind === 'session.list' && listed.sessions.length).toBe(1);

    // Nothing else will ever be heard from this session.
    await until(async () => {
      const after = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
      expect(after.kind === 'session.list' && after.sessions).toEqual([]);
    });
  });

  it('records the pid from a notification too, for a daemon restarted mid-session', async () => {
    // A daemon that restarts never sees the running session's SessionStart. If
    // the first hook it does see is a notification, that has to carry the pid
    // as well, or an idle session that is then closed strands forever.
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ web: { enabled: false } }));
    h = await bootstrapDaemon({
      home: tmp, imAdapters: [],
      desktopNotifier: { notify: async () => {} },
      sweepMs: 20,
    });
    const sock = daemonSocketPath(tmp);

    await request(
      { kind: 'hook.notify', cwd: '/ghost2', sessionId: 's2', level: 'info', message: 'waiting for your input', agentPid: deadPid() },
      { socketPath: sock, timeoutMs: 2000 },
    );
    await until(async () => {
      const r = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
      expect(r.kind === 'session.list' && r.sessions).toEqual([]);
    });
  });
});
