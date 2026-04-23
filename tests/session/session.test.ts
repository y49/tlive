import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../../src/session/session.js';
import { SessionContext } from '../../src/session/context.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { FakeRuntime } from './fake-runtime.js';
import type { NotificationEvent } from '../../src/runtime/events.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tlive-sess-'));
  const persistence = new SessionPersistence(root); await persistence.init();
  const broker = new PermissionBroker();
  const runtime = new FakeRuntime('claude');
  const ctx = SessionContext.create({
    sessionId: 's1', workdir: '/x', workspaceId: 'ws', provider: 'claude',
  });
  const session = new Session({ ctx, runtime, persistence, broker });
  return { root, persistence, broker, runtime, session };
}

describe('Session', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await rm(env.root, { recursive: true, force: true }); });

  it('start() wires listeners, calls runtime.start, and transitions to active', async () => {
    await env.session.start({});
    expect(env.runtime.started).toBe(true);
    expect(env.session.getStatus()).toBe('active');
  });

  it('events from runtime are appended to history and persisted', async () => {
    await env.session.start({});
    const e: NotificationEvent = { kind: 'assistant_text', turnId: 't1', text: 'hi', complete: true };
    env.runtime.emitEvent(e);
    expect(env.session.getHistory()).toEqual([e]);
    // Flush microtasks
    await new Promise((r) => setImmediate(r));
    expect(await env.persistence.loadHistory('s1')).toEqual([e]);
  });

  it('session_complete transitions status to idle', async () => {
    await env.session.start({});
    env.runtime.emitEvent({ kind: 'session_complete', reason: 'normal', summary: 'done' });
    expect(env.session.getStatus()).toBe('idle');
  });

  it('sendInput forwards to runtime', async () => {
    await env.session.start({});
    await env.session.sendInput('hello', 'im');
    expect(env.runtime.inputs).toEqual(['hello']);
  });

  it('sendInput throws after stop', async () => {
    await env.session.start({});
    await env.session.stop();
    await expect(env.session.sendInput('x', 'im')).rejects.toThrow(/stopped/);
  });

  it('handlePermission preserves the runtime-provided id verbatim', async () => {
    await env.session.start({});
    env.runtime.emitPermission({
      id: 's1:tu1:inner:42', toolName: 'Bash', toolInput: {},
      category: 'exec', resolve: vi.fn(),
    });
    // T4 broker stores the runtime request by its full id; no re-keying.
    const pending = env.broker.pendingFor('s1');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('s1:tu1:inner:42');
  });

  it('setStatus guard: session_complete after stop does not flip status back to idle', async () => {
    await env.session.start({});
    await env.session.stop();
    // Simulate a late runtime event (unsubscribe should already block this in
    // practice; the guard is belt-and-suspenders for real SDK teardown races).
    env.runtime.emitEvent({ kind: 'session_complete', reason: 'normal', summary: 'late' });
    expect(env.session.getStatus()).toBe('stopped');
  });

  it('stop() aborts, unsubscribes, denies pending permissions, stops runtime', async () => {
    await env.session.start({});
    env.runtime.emitPermission({
      id: 's1:tu1', toolName: 'Bash', toolInput: {},
      category: 'exec', resolve: vi.fn(),
    });
    await env.session.stop();
    expect(env.runtime.stopCalls).toBe(1);
    expect(env.session.getStatus()).toBe('stopped');
    expect(env.broker.pendingFor('s1')).toEqual([]);
  });

  it('snapshot reflects status, cost, and pending permissions', async () => {
    await env.session.start({});
    env.runtime.emitUsage({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    // New v1.0 snapshot() returns SessionInfo with AgentStatus (phase-keyed);
    // legacy SessionSnapshot shape is available via snapshotLegacy().
    const info = env.session.snapshot();
    expect(info.cost.inputTokens).toBe(10);
    expect(info.status.phase).toBe('idle');
    const legacy = env.session.snapshotLegacy();
    expect(legacy.status).toBe('active');
    expect(legacy.pendingPermissionIds).toEqual([]);
  });

  it('subscribe receives event / status / permission / usage', async () => {
    const log: string[] = [];
    env.session.subscribe((ev) => log.push(ev.kind));
    await env.session.start({});
    env.runtime.emitEvent({ kind: 'heartbeat', elapsedMs: 5 });
    env.runtime.emitUsage({ inputTokens: 1, outputTokens: 1, costUsd: 0 });
    expect(log).toContain('status');
    expect(log).toContain('event');
    expect(log).toContain('usage');
  });
});
