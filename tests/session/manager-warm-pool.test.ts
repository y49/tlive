// tests/session/manager-warm-pool.test.ts
//
// T3 scope: warm-pool infrastructure is present but reuse is deferred. Real
// AgentRuntime implementations (Claude, Codex) throw on a second start() call,
// so SessionManager.stop() always fully stops the runtime — the pool never has
// anything parked in production. These tests lock that contract in:
//   1) stop() calls runtime.stop() (not park), and a subsequent createLocal
//      goes through the factory and gets a FRESH runtime instance.
//   2) WarmRuntimePool.park() still works in isolation — the scaffolding is
//      live so a future task (T9+) can re-enable pooling once
//      AgentRuntime.reset() lands.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { WarmRuntimePool } from '../../src/session/warm-pool.js';
import { FakeRuntime } from './fake-runtime.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tlive-warm-mgr-'));
  const persistence = new SessionPersistence(root); await persistence.init();
  const broker = new PermissionBroker();
  const warmPool = new WarmRuntimePool({ ttlSec: 60, max: 3 });
  const runtimes: FakeRuntime[] = [];
  const factory = (provider: 'claude' | 'codex') => {
    const r = new FakeRuntime(provider); runtimes.push(r); return r;
  };
  const mgr = new SessionManager({ persistence, broker, runtimeFactory: factory, warmPool });
  return { root, persistence, broker, mgr, runtimes, warmPool };
}

describe('SessionManager stop -> factory (no warm-pool reuse in T3)', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await rm(env.root, { recursive: true, force: true }); });

  it('stop calls runtime.stop(); next createLocal gets a fresh runtime', async () => {
    const first = await env.mgr.createLocal({
      workspaceId: 'ws-A', provider: 'claude', workdir: '/a', source: 'cli',
    });
    expect(env.runtimes).toHaveLength(1);
    const firstRuntime = env.runtimes[0];

    await env.mgr.stop(first.id);
    // Fully stopped — NOT parked.
    expect(firstRuntime.stopCalls).toBe(1);
    expect(env.warmPool.size()).toBe(0);

    const second = await env.mgr.createLocal({
      workspaceId: 'ws-A', provider: 'claude', workdir: '/a', source: 'cli',
    });
    // Factory invoked again — fresh runtime, not reused.
    expect(env.runtimes).toHaveLength(2);
    const secondRuntime = env.runtimes[1];
    expect(secondRuntime).not.toBe(firstRuntime);
    // Each runtime's prepare() ran exactly once (the production invariant).
    expect(firstRuntime.prepareCalls).toBe(1);
    expect(secondRuntime.prepareCalls).toBe(1);
  });

  it('stopAll stops every live session runtime; pool is empty', async () => {
    const a = await env.mgr.createLocal({
      workspaceId: 'ws-A', provider: 'claude', workdir: '/a', source: 'cli',
    });
    const b = await env.mgr.createLocal({
      workspaceId: 'ws-B', provider: 'codex', workdir: '/b', source: 'cli',
    });
    expect(env.runtimes).toHaveLength(2);
    expect(a.id).not.toBe(b.id);

    await env.mgr.stopAll();

    expect(env.warmPool.size()).toBe(0);
    for (const r of env.runtimes) expect(r.stopCalls).toBe(1);
  });
});

describe('WarmRuntimePool scaffolding (unit — usable when T9 re-enables pooling)', () => {
  it('park then pluck still roundtrips a runtime in isolation', () => {
    const pool = new WarmRuntimePool({ ttlSec: 60, max: 2 });
    const r = new FakeRuntime('claude');
    pool.park(r, 'ws-X');
    expect(pool.size()).toBe(1);
    const plucked = pool.pluck('claude', 'ws-X');
    expect(plucked).toBe(r);
    expect(pool.size()).toBe(0);
    // Pool does not call prepare() itself — the would-be consumer does,
    // which is why reuse stays disabled until runtime.reset() exists.
    expect(r.prepareCalls).toBe(0);
    expect(r.stopCalls).toBe(0);
  });
});
