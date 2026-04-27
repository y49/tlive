// tests/integration/warm-pool.test.ts
//
// v1.0 contract: AgentRuntime.reset() does not exist — real Claude/Codex
// runtimes throw on a second start(), so SessionManager.stop() fully stops
// every runtime and the next createLocal always goes through the factory.
// The pool scaffolding is live but no production path parks runtimes.
//
// This test locks the invariant: stop → factory → fresh runtime. It
// complements tests/session/manager-warm-pool.test.ts at the integration
// level by plugging in persistence + rollups to catch any stray coupling.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { CostRollupStore } from '../../src/cost/rollups.js';
import { WarmRuntimePool } from '../../src/session/warm-pool.js';
import { FakeRuntime } from '../session/fake-runtime.js';

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'tlive-warm-int-'));
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const broker = new PermissionBroker();
  const pool = new WarmRuntimePool({ ttlSec: 60, max: 4 });
  const rollups = new CostRollupStore(join(home, 'cost', 'rollups.jsonl'));
  const runtimes: FakeRuntime[] = [];
  const mgr = new SessionManager({
    persistence,
    broker,
    runtimeFactory: (provider) => { const r = new FakeRuntime(provider); runtimes.push(r); return r; },
    warmPool: pool,
    rollupStore: rollups,
  });
  return { home, mgr, pool, runtimes };
}

describe('integration: warm-pool (v1.0 — factory always)', () => {
  let env: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => { env = await boot(); });
  afterEach(async () => {
    await env.mgr.stopAll().catch(() => undefined);
    rmSync(env.home, { recursive: true, force: true });
  });

  it('stop + re-create minting a fresh runtime; pool stays empty', async () => {
    const first = await env.mgr.createLocal({
      workspaceId: 'ws-warm', provider: 'claude', workdir: env.home, source: 'im',
    });
    expect(env.runtimes.length).toBe(1);

    await env.mgr.stop(first.id);
    expect(env.pool.size()).toBe(0);
    expect(env.runtimes[0]!.stopCalls).toBe(1);

    const second = await env.mgr.createLocal({
      workspaceId: 'ws-warm', provider: 'claude', workdir: env.home, source: 'im',
    });
    expect(env.runtimes.length).toBe(2);
    expect(env.runtimes[1]).not.toBe(env.runtimes[0]);
    expect(env.runtimes[1]!.prepareCalls).toBe(1);
    // Second session got a different sdkSessionId.
    expect(second.id).not.toBe(first.id);
  });

  it('WarmRuntimePool remains usable in isolation (scaffolding contract)', async () => {
    const r = new FakeRuntime('claude');
    env.pool.park(r, 'ws-warm');
    expect(env.pool.size()).toBe(1);
    const plucked = env.pool.pluck('claude', 'ws-warm');
    expect(plucked).toBe(r);
    // Production: SessionManager never actually parks, so pluck always returns null
    // during createLocal. Verified in the first test above.
  });
});
