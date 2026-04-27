// tests/session/cost-wire.test.ts
//
// Regression coverage for the LocalSession -> CostRollupStore wiring
// (T3 review fixup). Every turn_end must append a RollupDelta so the
// /cost dashboard reflects real usage across sessions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSession } from '../../src/session/local-session.js';
import { SessionContext } from '../../src/session/context.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { CostRollupStore, type RollupDelta } from '../../src/cost/rollups.js';
import { FakeRuntime } from './fake-runtime.js';

/** In-memory subclass that records appended deltas for assertions. */
class RecordingRollupStore extends CostRollupStore {
  readonly appended: RollupDelta[] = [];
  constructor() { super('/tmp/never-written.jsonl'); }
  override async append(delta: RollupDelta): Promise<void> {
    this.appended.push(delta);
  }
}

async function setup(opts: { rollupStore?: CostRollupStore } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tlive-costwire-'));
  const persistence = new SessionPersistence(root); await persistence.init();
  const broker = new PermissionBroker();
  const runtime = new FakeRuntime('claude');
  const ctx = SessionContext.create({
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    workdir: '/proj',
    workspaceId: 'ws-cost',
    provider: 'claude',
  });
  const session = new LocalSession({
    ctx, runtime, persistence, broker, rollupStore: opts.rollupStore,
  });
  return { root, runtime, session };
}

describe('LocalSession -> CostRollupStore', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => { if (env) await rm(env.root, { recursive: true, force: true }); });

  it('turn_end appends a RollupDelta with matching fields', async () => {
    const store = new RecordingRollupStore();
    env = await setup({ rollupStore: store });
    await env.session.prepare({}); env.session.attachSink();
    env.runtime.emitEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 10,
      costUsd: 0.12, tokensIn: 500, tokensOut: 200,
    });
    // Yield to the microtask queue so the fire-and-forget append resolves.
    await Promise.resolve();

    expect(store.appended).toHaveLength(1);
    const delta = store.appended[0];
    expect(delta.workspaceId).toBe('ws-cost');
    expect(delta.sdkSessionId).toBe(env.session.id);
    expect(delta.deltaUsd).toBe(0.12);
    expect(delta.deltaIn).toBe(500);
    expect(delta.deltaOut).toBe(200);
    expect(delta.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof delta.at).toBe('number');
  });

  it('no-ops silently when rollupStore is undefined', async () => {
    env = await setup();
    await env.session.prepare({}); env.session.attachSink();
    // Must not throw.
    env.runtime.emitEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 10,
      costUsd: 0.01, tokensIn: 1, tokensOut: 1,
    });
    expect(env.session.cost.totalCost).toBe(0.01);
  });

  it('append failures do not crash the turn_end fold', async () => {
    class FlakyStore extends CostRollupStore {
      constructor() { super('/tmp/flaky.jsonl'); }
      override async append(): Promise<void> { throw new Error('disk full'); }
    }
    const store = new FlakyStore();
    env = await setup({ rollupStore: store });
    await env.session.prepare({}); env.session.attachSink();
    // Emitting the event must not throw synchronously, and the cost tracker
    // still folds the event.
    expect(() => env.runtime.emitEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 10,
      costUsd: 0.03, tokensIn: 1, tokensOut: 1,
    })).not.toThrow();
    // Let the rejected promise settle without throwing.
    await Promise.resolve();
    expect(env.session.cost.totalCost).toBe(0.03);
  });
});
