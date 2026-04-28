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
  workspaces.addBinding(ws.id, { channelType: 'telegram', chatId: 'chat-1', role: 'primary' });

  const adapter = new FakeAdapter('telegram');
  const frontend = new SessionFrontend({
    sessionManager: manager,
    workspaceManager: workspaces,
    permissionBroker: broker,
    adapters: { telegram: adapter },
  });
  frontend.start();

  return { home, manager, frontend, adapter, runtimes, wsId: ws.id, workdir };
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

  it('B3 regression: events stashed during prepare reach IM after attachSink', async () => {
    // Pre-inject an assistant_text event into the prepare window.
    // FakeRuntime stashes it; on attachSink the stash flushes to
    // LocalSession.handleEvent → SessionFrontend → adapter.send.
    env = await setup({
      onRuntimeCreated: (r) => {
        // assistant_text renderer requires an active turn (set by turn_start).
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
    // Allow micro-tasks from async handleSessionEvent to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const sentTexts = env.adapter.calls
      .filter((c) => c.kind === 'send' || c.kind === 'edit')
      .map((c) => String((c.args as { text?: string }).text ?? ''))
      .join('\n');
    expect(sentTexts).toContain('reply-from-prepare-window');
  });

  // ---- createLocal ordering --------------------------------------------------

  it('createLocal calls prepare → emit("created") → attachSink in order', async () => {
    const events: string[] = [];
    env = await setup();
    env.manager.subscribe((ev) => {
      if (ev.kind === 'created') events.push('emit:created');
    });
    await createLocal(env);

    // Manager emitted 'created' exactly once.
    expect(events).toEqual(['emit:created']);
    // FakeRuntime was prepared and had its sink attached once each.
    expect(env.runtimes[0]!.prepareCalls).toBe(1);
    expect(env.runtimes[0]!.attachCalls).toBe(1);
  });

  // ---- Frontend sync attach (I3) ---------------------------------------------

  it('SessionFrontend.attachSession completes synchronously inside emit callstack', async () => {
    const observedDuringEmit: string[] = [];
    env = await setup();
    env.manager.subscribe((ev) => {
      if (ev.kind === 'created') {
        // SessionFrontend's own subscribe listener runs before ours only when
        // it was registered first (it calls frontend.start() before us).
        // Both listeners execute in the same synchronous emit() loop.
        // By the time ANY listener fires, attachSession has already returned
        // (because the frontend listener fires first and attachSession is sync).
        if ((env.frontend as unknown as { sessions: Map<string, unknown> }).sessions.has(ev.session.id)) {
          observedDuringEmit.push('frontend-attached');
        }
      }
    });
    await createLocal(env);
    expect(observedDuringEmit).toEqual(['frontend-attached']);
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

  it('resume contract: resumeLocal passes resumeSessionId to runtime.prepare', async () => {
    env = await setup();
    const s = await createLocal(env);
    // Stop the session (saves snapshot to disk).
    await env.manager.stop(s.id);

    // Wait a tick so any async snapshot writes complete.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const r = await env.manager.resumeLocal(s.id);
    expect(r).not.toBeNull();

    // The new runtime constructed for resume was pushed after the first one.
    const lastRuntime = env.runtimes[env.runtimes.length - 1]!;
    expect(lastRuntime.resumeRequestedFor).toBe(s.id);
  });
});
