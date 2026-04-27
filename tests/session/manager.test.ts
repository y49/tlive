import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { FakeRuntime } from './fake-runtime.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tlive-mgr-'));
  const persistence = new SessionPersistence(root); await persistence.init();
  const broker = new PermissionBroker();
  const runtimes: FakeRuntime[] = [];
  const factory = (provider: 'claude' | 'codex') => {
    const r = new FakeRuntime(provider); runtimes.push(r); return r;
  };
  const mgr = new SessionManager({ persistence, broker, runtimeFactory: factory });
  return { root, persistence, broker, mgr, runtimes };
}

describe('SessionManager', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await rm(env.root, { recursive: true, force: true }); });

  it('create allocates a fresh session and emits "created"', async () => {
    const events: string[] = [];
    env.mgr.subscribe((ev) => events.push(ev.kind));
    const s = await env.mgr.create({
      workspaceId: 'ws', provider: 'claude', workdir: '/x', source: 'cli',
    });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.mgr.get(s.id)).toBe(s);
    expect(events).toContain('created');
  });

  it('list returns snapshots of live sessions', async () => {
    await env.mgr.create({ workspaceId: 'ws', provider: 'claude', workdir: '/a', source: 'cli' });
    await env.mgr.create({ workspaceId: 'ws', provider: 'codex', workdir: '/b', source: 'im' });
    expect(env.mgr.list()).toHaveLength(2);
  });

  it('stop removes the session from the map and emits "stopped"', async () => {
    const s = await env.mgr.create({ workspaceId: 'ws', provider: 'claude', workdir: '/a', source: 'cli' });
    const events: string[] = [];
    env.mgr.subscribe((ev) => events.push(ev.kind));
    await env.mgr.stop(s.id);
    expect(env.mgr.get(s.id)).toBeUndefined();
    expect(events).toContain('stopped');
  });

  it('hydrateFromDisk returns persisted snapshots without restarting runtimes', async () => {
    const s = await env.mgr.create({ workspaceId: 'ws', provider: 'claude', workdir: '/a', source: 'cli' });
    const idBefore = s.id;
    // Yield to let the fire-and-forget saveSnapshot in attachSink() flush to disk.
    await new Promise((r) => setTimeout(r, 20));
    // New manager pointed at same disk
    const persistence2 = new SessionPersistence(env.root);
    await persistence2.init();
    const mgr2 = new SessionManager({
      persistence: persistence2, broker: env.broker, runtimeFactory: () => new FakeRuntime(),
    });
    const snaps = await mgr2.hydrateFromDisk();
    expect(snaps.map((x) => x.id)).toContain(idBefore);
    // mgr2 has no live session yet
    expect(mgr2.get(idBefore)).toBeUndefined();
  });

  it('resume rebuilds an idle session', async () => {
    const s = await env.mgr.create({ workspaceId: 'ws', provider: 'claude', workdir: '/a', source: 'cli' });
    // Yield to let the fire-and-forget saveSnapshot in attachSink() flush to disk
    // before we overwrite the snapshot with status=idle (avoids .tmp rename race).
    await new Promise((r) => setTimeout(r, 20));
    // Force a snapshot with status=idle on disk using the legacy shape (ctx required by loadSnapshot).
    await env.persistence.saveSnapshot({ ...s.snapshotLegacy(), status: 'idle' });
    await env.mgr.stop(s.id);
    const resumed = await env.mgr.resume(s.id);
    expect(resumed).not.toBeNull();
    expect(resumed!.id).toBe(s.id);
  });

  it('resume returns null for unknown id', async () => {
    expect(await env.mgr.resume('nope')).toBeNull();
  });

  it('stopAll stops every live session', async () => {
    const a = await env.mgr.create({ workspaceId: 'ws', provider: 'claude', workdir: '/a', source: 'cli' });
    const b = await env.mgr.create({ workspaceId: 'ws', provider: 'claude', workdir: '/b', source: 'cli' });
    expect(env.mgr.list()).toHaveLength(2);
    await env.mgr.stopAll();
    expect(env.mgr.get(a.id)).toBeUndefined();
    expect(env.mgr.get(b.id)).toBeUndefined();
    expect(env.mgr.list()).toHaveLength(0);
  });
});
