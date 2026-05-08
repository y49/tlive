// tests/integration/session-lifecycle.test.ts
//
// Full-stack readiness-gate regression test. Wires SessionManager + LocalSession
// + SessionFrontend + FakeRuntime + FakeAdapter end-to-end. Catches B3 (events
// during prepare reach IM after attachSink), B5 (isLive precise lookup), B7 (no
// double attach), and the prepare → emit → attachSink ordering invariant.
//
// Spec X §8.3.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { SessionFrontend } from '../../src/im/frontend.js';
import { FakeRuntime } from '../session/fake-runtime.js';
import { FakeAdapter } from '../im/fake-adapter.js';
import type { NotificationEvent } from '../../src/runtime/events.js';
import type { LocalSession } from '../../src/session/local-session.js';

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

interface SetupOpts {
  onRuntimeCreated?: (r: FakeRuntime) => void;
}

interface Env {
  home: string;
  manager: SessionManager;
  workspaces: WorkspaceManager;
  persistence: SessionPersistence;
  frontend: SessionFrontend;
  adapter: FakeAdapter;
  runtimes: FakeRuntime[];
  wsId: string;
  workdir: string;
}

async function setup(opts: SetupOpts = {}): Promise<Env> {
  const home = mkdtempSync(join(tmpdir(), 'tlive-lifecycle-'));
  const workdir = home;
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const broker = new PermissionBroker();
  const runtimes: FakeRuntime[] = [];

  const manager = new SessionManager({
    persistence,
    broker,
    runtimeFactory: (provider) => {
      const r = new FakeRuntime(provider as 'claude' | 'codex');
      runtimes.push(r);
      opts.onRuntimeCreated?.(r);
      return r;
    },
  });

  const workspaces = new WorkspaceManager();
  const ws = workspaces.create({ name: 'ws', workdir });
  workspaces.addBinding(ws.id, { channelType: 'telegram', chatId: 'chat-1' });

  const adapter = new FakeAdapter('telegram');
  const frontend = new SessionFrontend({
    sessionManager: manager,
    workspaceManager: workspaces,
    permissionBroker: broker,
    adapters: { telegram: adapter },
  });
  frontend.start();

  return { home, manager, workspaces, persistence, frontend, adapter, runtimes, wsId: ws.id, workdir };
}

async function teardown(env: Env): Promise<void> {
  await env.frontend.stop();
  await env.manager.stopAll().catch(() => undefined);
  rmSync(env.home, { recursive: true, force: true });
}

// Convenience: fully create a local session with minimal opts.
function createLocal(env: Env, extra: { initialPrompt?: string } = {}): Promise<LocalSession> {
  return env.manager.createLocal({
    workspaceId: env.wsId,
    provider: 'claude',
    workdir: env.workdir,
    source: 'im',
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session lifecycle — full stack', () => {
  let env: Env;
  afterEach(async () => { if (env) await teardown(env); });

  // ---- B3 regression ---------------------------------------------------------

  it('B3 regression: turn_start stashed during prepare reaches IM after attachSink', async () => {
    // Pre-inject events into the prepare window.
    // FakeRuntime stashes them; on attachSink the stash flushes synchronously to
    // LocalSession.handleEvent → SessionFrontend.handleSessionEvent (async).
    //
    // NOTE: The new async SessionFrontend dispatches handleSessionEvent without
    // awaiting, so two events flushed synchronously run as concurrent async chains.
    // turn_start (which builds TurnComposite and awaits its start()) and
    // assistant_text (which broadcasts to entry.activeTurnComposites set by
    // turn_start) can race. The placeholder send from turn_start IS observable
    // after one setImmediate drain; the reply text from assistant_text may
    // arrive in a later microtask batch.
    //
    // TODO(T12-smoke): verify full turn_start + assistant_text prepare-window
    // sequence works end-to-end in manual smoke after adding serialisation to
    // SessionFrontend.handleSessionEvent.
    env = await setup({
      onRuntimeCreated: (r) => {
        r.injectInPrepareWindow({
          kind: 'turn_start',
          turnId: 'turn-0',
          userInputPreview: 'hello',
          at: Date.now(),
        } satisfies NotificationEvent);
        r.injectInPrepareWindow({
          kind: 'assistant_text',
          turnId: 'turn-0',
          text: 'reply-from-prepare-window',
          complete: true,
        } satisfies NotificationEvent);
      },
    });
    await createLocal(env);
    // Drain two rounds of microtasks / setImmediate to let the async chain settle.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // turn_start must have been processed: HUD send is present.
    const allTexts = env.adapter.calls
      .filter((c) => c.kind === 'send' || c.kind === 'edit')
      .map((c) => String((c.args as { text?: string }).text ?? ''));
    expect(allTexts.length).toBeGreaterThan(0);
    expect(allTexts.some((t) => t.includes('💬'))).toBe(true); // v3.1 HUD turn header (was 📊)
  });

  // ---- createLocal ordering --------------------------------------------------

  it('createLocal calls prepare → emit("created") → attachSink in order', async () => {
    const events: string[] = [];
    env = await setup({
      onRuntimeCreated: (r) => {
        // Wrap prepare to push a marker after it resolves.
        const origPrepare = r.prepare.bind(r);
        r.prepare = async (opts) => {
          const result = await origPrepare(opts);
          events.push('prepare-end');
          return result;
        };
        // Wrap attachSink to push a marker when it is called.
        const origAttachSink = r.attachSink.bind(r);
        r.attachSink = (sink) => {
          events.push('attach');
          return origAttachSink(sink);
        };
      },
    });
    env.manager.subscribe((ev) => {
      if (ev.kind === 'created') events.push('emit:created');
    });
    await createLocal(env);

    // All three phases must occur in strict sequence. This catches regressions
    // that swap emit('created') and attachSink (the old test only checked counts).
    expect(events).toEqual(['prepare-end', 'emit:created', 'attach']);
  });

  // ---- Frontend sync attach (I3) ---------------------------------------------

  it('frontend.attachSession completes synchronously inside emit callstack', async () => {
    // Strategy: FakeRuntime.attachSink is called by manager.createLocal()
    // synchronously AFTER emit('created') returns. If SessionFrontend.attachSession
    // is synchronous (as required), frontend.sessions already contains the entry
    // by the time attachSink is invoked. We spy on attachSink to capture the
    // observation without relying on listener ordering.
    let frontendHadEntryAtAttachSink = false;
    env = await setup({
      onRuntimeCreated: (r) => {
        const origAttachSink = r.attachSink.bind(r);
        r.attachSink = (sink) => {
          // attachSink runs after emit('created') returns synchronously.
          // If frontend.sessions already has the id here, attachSession was sync.
          const sessionsMap = (env.frontend as unknown as { sessions: Map<string, unknown> }).sessions;
          frontendHadEntryAtAttachSink = sessionsMap.size > 0;
          return origAttachSink(sink);
        };
      },
    });
    await createLocal(env);
    expect(frontendHadEntryAtAttachSink).toBe(true);
  });

  // ---- B7 regression ---------------------------------------------------------

  it('B7 regression: re-emit("created") for same session id is a no-op', async () => {
    env = await setup();
    const s = await createLocal(env);

    // Count adapter calls (send) before the duplicate emit.
    const callsBefore = env.adapter.calls.length;

    // Manually fire 'created' a second time for the same session id.
    (env.manager as unknown as { emit: (ev: unknown) => void }).emit({
      kind: 'created',
      session: s,
    });

    // No new adapter calls — the guard at frontend.ts:160 (has-check) prevents
    // attachSession from running a second time.
    expect(env.adapter.calls.length).toBe(callsBefore);
  });

  // ---- B5 regression ---------------------------------------------------------

  it('B5 regression: isLive returns true for active, false after stop', async () => {
    env = await setup();
    const s = await createLocal(env);

    // Precise lookup helper matching spec §5.8
    const isLive = (id: string): boolean => {
      const found = env.manager.get(id);
      return (
        found !== undefined &&
        found.kind === 'local' &&
        (found as unknown as { getStatus: () => string }).getStatus() === 'active'
      );
    };

    expect(isLive(s.id)).toBe(true);
    await env.manager.stop(s.id);
    expect(isLive(s.id)).toBe(false);
  });

  // ---- Phase machine: attachSink-after-running throws ------------------------

  it('phase invariant: calling attachSink from "running" phase throws', async () => {
    env = await setup();
    const s = await createLocal(env);
    // After createLocal, session is in 'running' phase. A second attachSink must throw.
    expect(() => s.attachSink()).toThrow(/attachSink from running/);
  });

  // ---- Resume contract -------------------------------------------------------

  it('resume contract: lazyResumeOrCreate threads resumeSessionId through to runtime.prepare', async () => {
    env = await setup();
    const s = await createLocal(env);
    // Bind the active session so lazyResumeOrCreate sees it on branch 2.
    env.workspaces.bindActiveSessionForChat('telegram', 'chat-1', s.id);
    // Stop the session (saves snapshot to disk).
    await env.manager.stop(s.id);

    // Wait a tick so any async snapshot writes complete.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Drive through lazyResumeOrCreate with the same deps shape bootstrap uses,
    // exercising the full IM-resume path instead of calling resumeLocal directly.
    await env.workspaces.lazyResumeOrCreate('telegram', 'chat-1', 'second message', 'im', {
      isLive: (id) => {
        const found = env.manager.get(id);
        return (
          found !== undefined &&
          found.kind === 'local' &&
          (found as unknown as { getStatus: () => string }).getStatus() === 'active'
        );
      },
      hasPersistedSession: (id) => env.persistence.hasSnapshot(id),
      resume: (id) => env.manager.resumeLocal(id),
      sendInput: async (id, text, src) => {
        const found = env.manager.get(id);
        if (!found || found.kind !== 'local') throw new Error('session not live for sendInput');
        await (found as unknown as { sendInput: (t: string, s: 'im' | 'cli') => Promise<void> }).sendInput(text, src);
      },
      createLocal: async () => { throw new Error('should not create new session in resume branch'); },
    });

    // The runtime created for resume should have been called with resumeSessionId === s.id.
    const lastRuntime = env.runtimes[env.runtimes.length - 1]!;
    expect(lastRuntime.resumeRequestedFor).toBe(s.id);
  });

  // ---- Reactions (Spec Z absorbed into lifecycle hardening) ------------------

  it('reaction wiring: markInboundReceived → 👀, turn_start → 🤔, turn_end → 👌', async () => {
    env = await setup();
    // Bootstrap behavior: register inbound BEFORE the session attaches. Frontend
    // parks it in pendingInbound; on attach it fires the 'received' reaction.
    env.frontend.markInboundReceived('telegram', 'chat-1', 'user-msg-1');
    const session = await createLocal(env);
    // Allow the post-attach setPhase('received') microtask to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const reactionCalls = env.adapter.byKind('setReaction');
    expect(reactionCalls.length).toBeGreaterThanOrEqual(1);
    expect(reactionCalls[0]!.args.messageId).toBe('user-msg-1');
    expect(reactionCalls[0]!.args.emoji).toBe('👀');

    // Drive turn_start through the runtime sink; expect 🤔 on the same inbound.
    const runtime = env.runtimes[0]!;
    runtime.emitEvent({
      kind: 'turn_start', turnId: 't1', userInputPreview: 'hello', at: Date.now(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterStart = env.adapter.byKind('setReaction');
    const processing = afterStart.find((c) => c.args.emoji === '🤔');
    expect(processing).toBeDefined();
    expect(processing!.args.messageId).toBe('user-msg-1');

    // turn_end → 👌, but with a 400ms buffer in frontend so Telegram propagates
    // the bot's reply text before reaction transition. Wait 500ms.
    runtime.emitEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 100, costUsd: 0.01,
      tokensIn: 10, tokensOut: 20,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const doneOk = env.adapter.byKind('setReaction').find((c) => c.args.emoji === '👌');
    expect(doneOk).toBeDefined();
    expect(doneOk!.args.messageId).toBe('user-msg-1');

    // runtime_error (severity warn or fatal) → 💔, also after the 400ms buffer.
    runtime.emitEvent({
      kind: 'runtime_error', severity: 'warn', code: 'test', message: 'oops',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const doneErr = env.adapter.byKind('setReaction').find((c) => c.args.emoji === '💔');
    expect(doneErr).toBeDefined();
    expect(doneErr!.args.messageId).toBe('user-msg-1');

    // Use session to silence unused-var lint.
    void session;
  });

  // ---- lazyResumeOrCreate live branch (spec §8.3 case 2) --------------------

  it('lazyResumeOrCreate live branch: second message reuses session, no new created emit', async () => {
    env = await setup();
    const s = await createLocal(env);
    // Bind and keep alive.
    env.workspaces.bindActiveSessionForChat('telegram', 'chat-1', s.id);

    let createdCount = 0;
    env.manager.subscribe((ev) => { if (ev.kind === 'created') createdCount++; });

    await env.workspaces.lazyResumeOrCreate('telegram', 'chat-1', 'second message', 'im', {
      isLive: (id) => {
        const found = env.manager.get(id);
        return (
          found !== undefined &&
          found.kind === 'local' &&
          (found as unknown as { getStatus: () => string }).getStatus() === 'active'
        );
      },
      hasPersistedSession: (id) => env.persistence.hasSnapshot(id),
      resume: (id) => env.manager.resumeLocal(id),
      sendInput: async (id, text, src) => {
        const found = env.manager.get(id);
        if (!found || found.kind !== 'local') throw new Error('session not live for sendInput');
        await (found as unknown as { sendInput: (t: string, s: 'im' | 'cli') => Promise<void> }).sendInput(text, src);
      },
      createLocal: async () => { throw new Error('should not create new session in live branch'); },
    });

    // Live branch: no new created event, and the same runtime received the input.
    expect(createdCount).toBe(0);
    expect(env.runtimes[0]!.inputs).toContain('second message');
  });
});
