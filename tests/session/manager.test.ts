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
  afterEach(async () => {
    // Stop any sessions left running so their tracked saves drain before rm.
    await env.mgr.stopAll().catch(() => undefined);
    await rm(env.root, { recursive: true, force: true });
  });

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
    // Flush in-flight tracked saves so the snapshot is durably on disk before
    // the second manager reads it.
    await s.flushPendingPersistence();
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
    // Flush in-flight tracked saves before overwriting the snapshot so
    // stop() drain does not clobber the idle status we write next.
    await s.flushPendingPersistence();
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

  it('createLocal calls prepare → emit("created") → attachSink in order', async () => {
    const events: string[] = [];
    const capturedRuntimes: FakeRuntime[] = [];

    // Build a custom manager with a wrapped runtimeFactory so we can observe
    // the exact call sequence, not just presence.
    const mgr2 = new SessionManager({
      persistence: env.persistence,
      broker: env.broker,
      runtimeFactory: (provider) => {
        const r = new FakeRuntime(provider);
        const origPrepare = r.prepare.bind(r);
        const origAttachSink = r.attachSink.bind(r);
        r.prepare = async (opts) => {
          events.push('prepare');
          return origPrepare(opts);
        };
        r.attachSink = (sink) => {
          events.push('attach');
          return origAttachSink(sink);
        };
        capturedRuntimes.push(r);
        return r;
      },
    });
    mgr2.subscribe((ev) => {
      if (ev.kind === 'created') events.push('emit:created');
    });

    await mgr2.createLocal({
      workspaceId: 'ws-order', provider: 'claude', workdir: '/tmp', source: 'cli',
    });

    expect(events).toEqual(['prepare', 'emit:created', 'attach']);
    expect(capturedRuntimes[0]!.prepareCalls).toBe(1);
    expect(capturedRuntimes[0]!.attachCalls).toBe(1);

    // Drain the secondary manager's tracked saves before afterEach rm.
    await mgr2.stopAll();
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
