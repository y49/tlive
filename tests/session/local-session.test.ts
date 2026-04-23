// tests/session/local-session.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSession } from '../../src/session/local-session.js';
import { SessionContext } from '../../src/session/context.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/session/permission-broker.js';
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
  afterEach(async () => { await rm(env.root, { recursive: true, force: true }); });

  it('shortAlias is 8 hex chars derived from id', () => {
    expect(env.session.shortAlias).toBe('12345678');
  });

  it('kind is "local"', () => {
    expect(env.session.kind).toBe('local');
  });

  it('start() marks isReady and fires onSessionIdReady', async () => {
    const heard: string[] = [];
    env.session.onSessionIdReady((id) => heard.push(id));
    expect(env.session.isReady).toBe(false);
    await env.session.start({});
    expect(env.session.isReady).toBe(true);
    expect(heard).toEqual([env.session.id]);
  });

  it('onSessionIdReady called post-ready fires synchronously', async () => {
    await env.session.start({});
    const heard: string[] = [];
    env.session.onSessionIdReady((id) => heard.push(id));
    expect(heard).toEqual([env.session.id]);
  });

  it('snapshot() returns SessionInfo with phase-keyed AgentStatus', async () => {
    await env.session.start({});
    const info = env.session.snapshot();
    expect(info.kind).toBe('local');
    expect(info.shortAlias).toBe('12345678');
    expect(info.status.phase).toBe('idle');
  });

  it('turn_end folds cost into CostTracker', async () => {
    await env.session.start({});
    const e: NotificationEvent = { kind: 'turn_end', turnId: 't1', durationMs: 10, costUsd: 0.05, tokensIn: 100, tokensOut: 50 };
    env.runtime.emitEvent(e);
    expect(env.session.cost.totalCost).toBe(0.05);
    expect(env.session.cost.inputTokens).toBe(100);
  });

  it('turn_start then turn_end transitions status thinking → idle', async () => {
    await env.session.start({});
    env.runtime.emitEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 1 });
    expect(env.session.status.phase).toBe('thinking');
    env.runtime.emitEvent({ kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0, tokensIn: 0, tokensOut: 0 });
    expect(env.session.status.phase).toBe('idle');
  });

  it('assistant_text marks cache warmth', async () => {
    await env.session.start({});
    env.runtime.emitEvent({ kind: 'assistant_text', turnId: 't1', text: 'hi', complete: true });
    expect(env.session.cacheWarmth.isWarm()).toBe(true);
  });

  it('subscribeEvents fans out both event and status_change', async () => {
    const kinds: string[] = [];
    env.session.subscribeEvents((ev) => kinds.push(ev.kind));
    await env.session.start({});
    env.runtime.emitEvent({ kind: 'heartbeat', elapsedMs: 1 });
    expect(kinds).toContain('event');
    expect(kinds).toContain('status_change');
  });

  it('interrupt rejects pending permissions and transitions to interrupted', async () => {
    await env.session.start({});
    env.runtime.emitPermission({
      id: '12345678-aaaa-bbbb-cccc-dddddddddddd:tu1',
      toolName: 'Bash', toolInput: {}, resolve: () => undefined,
    });
    await env.session.interrupt();
    expect(env.broker.pendingCount()).toBe(0);
    expect(env.session.status.phase).toBe('interrupted');
  });

  it('BudgetGuard fires interrupt + runtime_error when cap exceeded', async () => {
    const { session, runtime } = await setup({ maxBudgetUsd: 0.02 });
    await session.start({});
    const errors: string[] = [];
    session.onEvent((e) => { if (e.kind === 'runtime_error') errors.push(e.code); });
    runtime.emitEvent({ kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0.03, tokensIn: 1, tokensOut: 1 });
    expect(errors).toContain('budget_exceeded');
    expect(session.status.phase).toBe('errored');
  });

  it('interrupt preserves errored phase set by BudgetGuard', async () => {
    // Fresh session with a cap so budget_exceeded trips during the turn_end.
    // The FakeRuntime's interrupt() throws UnsupportedByRuntimeError, which
    // LocalSession swallows, so once the awaited interrupt resolves we still
    // need to see phase='errored' (not overwritten with 'interrupted').
    const local = await setup({ maxBudgetUsd: 0.01 });
    await local.session.start({});
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
    await rm(local.root, { recursive: true, force: true });
  });
});
