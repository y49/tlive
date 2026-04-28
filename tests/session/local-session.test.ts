// tests/session/local-session.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSession } from '../../src/session/local-session.js';
import { SessionContext } from '../../src/session/context.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { PolicyStore } from '../../src/permission/policy-store.js';
import { FakeRuntime } from './fake-runtime.js';
import type { NotificationEvent } from '../../src/runtime/events.js';

async function setup(opts: { maxBudgetUsd?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tlive-local-'));
  const persistence = new SessionPersistence(root); await persistence.init();
  const broker = new PermissionBroker();
  const runtime = new FakeRuntime('claude');
  const ctx = SessionContext.create({
    sessionId: '12345678-aaaa-bbbb-cccc-dddddddddddd',
    workdir: '/proj',
    workspaceId: 'ws-1',
    provider: 'claude',
  });
  const session = new LocalSession({ ctx, runtime, persistence, broker, ...opts });
  return { root, persistence, broker, runtime, session };
}

describe('LocalSession', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => {
    await env.session.stop().catch(() => undefined);
    await rm(env.root, { recursive: true, force: true });
  });

  it('shortAlias is 8 hex chars derived from id', () => {
    expect(env.session.shortAlias).toBe('12345678');
  });

  it('kind is "local"', () => {
    expect(env.session.kind).toBe('local');
  });

  it('prepare() marks isReady and fires onSessionIdReady', async () => {
    const heard: string[] = [];
    env.session.onSessionIdReady((id) => heard.push(id));
    expect(env.session.isReady).toBe(false);
    await env.session.prepare({});
    expect(env.session.isReady).toBe(true);
    expect(heard).toEqual([env.session.id]);
  });

  it('onSessionIdReady called post-ready fires synchronously', async () => {
    await env.session.prepare({});
    const heard: string[] = [];
    env.session.onSessionIdReady((id) => heard.push(id));
    expect(heard).toEqual([env.session.id]);
  });

  it('snapshot() returns SessionInfo with phase-keyed AgentStatus', async () => {
    await env.session.prepare({});
    env.session.attachSink();
    const info = env.session.snapshot();
    expect(info.kind).toBe('local');
    expect(info.shortAlias).toBe('12345678');
    expect(info.status.phase).toBe('idle');
  });

  it('turn_end folds cost into CostTracker', async () => {
    await env.session.prepare({});
    env.session.attachSink();
    const e: NotificationEvent = { kind: 'turn_end', turnId: 't1', durationMs: 10, costUsd: 0.05, tokensIn: 100, tokensOut: 50 };
    env.runtime.emitEvent(e);
    expect(env.session.cost.totalCost).toBe(0.05);
    expect(env.session.cost.inputTokens).toBe(100);
  });

  it('turn_start then turn_end transitions status thinking → idle', async () => {
    await env.session.prepare({});
    env.session.attachSink();
    env.runtime.emitEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 1 });
    expect(env.session.status.phase).toBe('thinking');
    env.runtime.emitEvent({ kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0, tokensIn: 0, tokensOut: 0 });
    expect(env.session.status.phase).toBe('idle');
  });

  it('assistant_text marks cache warmth', async () => {
    await env.session.prepare({});
    env.session.attachSink();
    env.runtime.emitEvent({ kind: 'assistant_text', turnId: 't1', text: 'hi', complete: true });
    expect(env.session.cacheWarmth.isWarm()).toBe(true);
  });

  it('onEvent + onStatusChange fan out both event and status', async () => {
    const eventKinds: string[] = [];
    const statusPhases: string[] = [];
    env.session.onEvent((e) => eventKinds.push(e.kind));
    env.session.onStatusChange((s) => statusPhases.push(s.phase));
    await env.session.prepare({});
    env.session.attachSink();
    env.runtime.emitEvent({ kind: 'heartbeat', elapsedMs: 1 });
    expect(eventKinds).toContain('heartbeat');
    expect(statusPhases.length).toBeGreaterThan(0);
  });

  it('interrupt rejects pending permissions and transitions to interrupted', async () => {
    await env.session.prepare({});
    env.session.attachSink();
    env.runtime.emitPermission({
      id: '12345678-aaaa-bbbb-cccc-dddddddddddd:tu1',
      toolName: 'Bash', toolInput: {}, category: 'exec',
      resolve: () => undefined,
    });
    await env.session.interrupt();
    expect(env.broker.pendingCount()).toBe(0);
    expect(env.session.status.phase).toBe('interrupted');
  });

  it('BudgetGuard fires interrupt + runtime_error when cap exceeded', async () => {
    const { session, runtime } = await setup({ maxBudgetUsd: 0.02 });
    await session.prepare({});
    session.attachSink();
    const errors: string[] = [];
    session.onEvent((e) => { if (e.kind === 'runtime_error') errors.push(e.code); });
    runtime.emitEvent({ kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0.03, tokensIn: 1, tokensOut: 1 });
    expect(errors).toContain('budget_exceeded');
    expect(session.status.phase).toBe('errored');
  });

  it('auto-resolved permission (policy match) does NOT create a pending broker entry', async () => {
    // Fresh setup so we can install a PolicyStore-backed broker.
    const root = await mkdtemp(join(tmpdir(), 'tlive-local-policy-'));
    try {
      const persistence = new SessionPersistence(root); await persistence.init();
      const store = new PolicyStore('ws-1', { file: join(root, 'policies.json') });
      await store.add({ toolName: 'Read' }, 'allow', 'workspace', 'user');
      const brokerEvents: any[] = [];
      const broker = new PermissionBroker({ policyStoreFor: () => store });
      broker.subscribe((e) => brokerEvents.push(e));
      const runtime = new FakeRuntime('claude');
      const ctx = SessionContext.create({
        sessionId: '22223333-aaaa-bbbb-cccc-dddddddddddd',
        workdir: '/proj',
        workspaceId: 'ws-1',
        provider: 'claude',
      });
      const session = new LocalSession({ ctx, runtime, persistence, broker });
      await session.prepare({});
      session.attachSink();

      // Runtime emits a matching permission request.
      const resolveSpy = ((): ((d: any) => void) => {
        let called: any;
        const fn = (d: any) => { called = d; };
        (fn as any).called = () => called;
        return fn;
      })();
      runtime.emitPermission({
        id: '22223333-aaaa-bbbb-cccc-dddddddddddd:tu-read',
        toolName: 'Read', toolInput: { file_path: '/etc/hosts' },
        category: 'generic',
        resolve: resolveSpy,
      });

      // Broker saw ONLY 'resolved' (policy auto-resolve), no 'pending'.
      const kinds = brokerEvents.map((e) => e.kind);
      expect(kinds).toEqual(['resolved']);
      expect(brokerEvents[0].autoResolvedBy).toMatch(/^pol-/);

      await session.flushPendingPersistence();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('interrupt preserves errored phase set by BudgetGuard', async () => {
    // Fresh session with a cap so budget_exceeded trips during the turn_end.
    // The FakeRuntime's interrupt() throws UnsupportedByRuntimeError, which
    // LocalSession swallows, so once the awaited interrupt resolves we still
    // need to see phase='errored' (not overwritten with 'interrupted').
    const local = await setup({ maxBudgetUsd: 0.01 });
    await local.session.prepare({});
    local.session.attachSink();
    local.runtime.emitEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 1,
      costUsd: 0.05, tokensIn: 1, tokensOut: 1,
    });
    // BudgetGuard.onEvent fires interrupt() asynchronously; await it.
    await local.session.interrupt();
    expect(local.session.status.phase).toBe('errored');
    if (local.session.status.phase === 'errored') {
      expect(local.session.status.code).toBe('budget_exceeded');
    }
    await local.session.flushPendingPersistence();
    await rm(local.root, { recursive: true, force: true });
  });
});
