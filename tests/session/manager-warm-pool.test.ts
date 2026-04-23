// tests/session/manager-warm-pool.test.ts
//
// Regression coverage for the WarmRuntimePool <-> SessionManager wiring
// (T3 review fixup). Stopping a LocalSession hands its runtime to the pool
// instead of calling runtime.stop(), so the next createLocal in the same
// (provider, workspaceId) plucks the warm instance. stopAll drains the pool
// unconditionally so daemon shutdown doesn't leak subprocesses.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/session/permission-broker.js';
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

describe('SessionManager <-> WarmRuntimePool', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await rm(env.root, { recursive: true, force: true }); });

  it('stop parks the runtime; next createLocal plucks the same instance', async () => {
    const first = await env.mgr.createLocal({
      workspaceId: 'ws-A', provider: 'claude', workdir: '/a', source: 'cli',
    });
    // Sanity: the factory made exactly one runtime.
    expect(env.runtimes).toHaveLength(1);
    const parkedRuntime = env.runtimes[0];

    await env.mgr.stop(first.id);
    // Runtime parked, not stopped.
    expect(parkedRuntime.stopCalls).toBe(0);
    expect(env.warmPool.size()).toBe(1);

    const second = await env.mgr.createLocal({
      workspaceId: 'ws-A', provider: 'claude', workdir: '/a', source: 'cli',
    });
    // Factory was NOT invoked a second time — the pool served the request.
    expect(env.runtimes).toHaveLength(1);
    expect(env.warmPool.size()).toBe(0);
    // Second session is wired to the same runtime instance (cross-checked
    // via the internal field; the public surface doesn't expose runtime).
    const secondRuntime = (second as unknown as { runtime: FakeRuntime }).runtime;
    expect(secondRuntime).toBe(parkedRuntime);
    // Pluck-then-start means the runtime's start() ran again for the reused
    // session — start/stop counts should be 2/0.
    expect(parkedRuntime.startCalls).toBe(2);
    expect(parkedRuntime.stopCalls).toBe(0);
  });

  it('stopAll drains the pool — no parked runtimes leak past shutdown', async () => {
    const a = await env.mgr.createLocal({
      workspaceId: 'ws-A', provider: 'claude', workdir: '/a', source: 'cli',
    });
    const b = await env.mgr.createLocal({
      workspaceId: 'ws-B', provider: 'codex', workdir: '/b', source: 'cli',
    });
    expect(env.runtimes).toHaveLength(2);
    expect(a.id).not.toBe(b.id);

    await env.mgr.stopAll();

    // Every runtime stopped (either via LocalSession.stop on the direct
    // session path, or via pool.drain on parked ones). Nothing left in pool.
    expect(env.warmPool.size()).toBe(0);
    for (const r of env.runtimes) expect(r.stopCalls).toBe(1);
  });
});
