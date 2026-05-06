// tests/workspace/manager.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager, WorkspaceConflictError, type LazyResumeDeps } from '../../src/workspace/manager.js';
import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { FakeRuntime } from '../session/fake-runtime.js';
import type { SessionLike } from '../../src/session/types.js';
import type { LocalSession } from '../../src/session/local-session.js';

function fakeSession(id: string): SessionLike {
  return {
    id,
    shortAlias: id.slice(0, 8),
    kind: 'local',
    provider: 'claude',
    workspaceId: 'ws-any',
    workdir: '/tmp',
    ctx: {} as SessionLike['ctx'],
    title: undefined,
    status: { phase: 'idle', queuedInputs: 0 },
    cost: {} as SessionLike['cost'],
    isReady: true,
    onEvent: () => () => undefined,
    onStatusChange: () => () => undefined,
    onSessionIdReady: () => () => undefined,
    snapshot: () => ({} as never),
  };
}

describe('WorkspaceManager create/lookup', () => {
  it('create+findByWorkdir+findByName+findByChat', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'tlive', workdir: '/home/y/tlive' });
    expect(wm.get(ws.id)).toBe(ws);
    expect(wm.findByWorkdir('/home/y/tlive')?.id).toBe(ws.id);
    expect(wm.findByName('tlive')?.id).toBe(ws.id);
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    expect(wm.findByChat('telegram', 'c1')?.id).toBe(ws.id);
    expect(wm.findByChat('feishu', 'c1')).toBeUndefined();
  });

  it('ensureForWorkdir auto-creates when absent, returns existing when present', () => {
    const wm = new WorkspaceManager();
    const first = wm.ensureForWorkdir('/proj');
    const second = wm.ensureForWorkdir('/proj');
    expect(second.id).toBe(first.id);
    expect(wm.list()).toHaveLength(1);
  });
});

describe('WorkspaceManager activeSessionId single-writer', () => {
  it('accepts binding to same id idempotently', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x' });
    wm.bindActiveSession(ws.id, 'sess-1');
    wm.bindActiveSession(ws.id, 'sess-1'); // no conflict
    expect(wm.getActiveSessionId(ws.id)).toBe('sess-1');
  });

  it('throws WorkspaceConflictError on competing claim', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x' });
    wm.bindActiveSession(ws.id, 'sess-1');
    expect(() => wm.bindActiveSession(ws.id, 'sess-2')).toThrow(WorkspaceConflictError);
  });

  it('clearActiveSession releases the slot so a fresh bind works', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x' });
    wm.bindActiveSession(ws.id, 'sess-1');
    wm.clearActiveSession(ws.id);
    wm.bindActiveSession(ws.id, 'sess-2'); // no throw
    expect(wm.getActiveSessionId(ws.id)).toBe('sess-2');
  });
});

describe('WorkspaceManager roles', () => {
  it('returns defaultRole when user unset, set/get overrides', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x', defaultRole: 'operator' });
    expect(wm.getRole(ws.id, 'alice')).toBe('operator');
    wm.setRole(ws.id, 'alice', 'admin');
    expect(wm.getRole(ws.id, 'alice')).toBe('admin');
    expect(wm.getRole(ws.id, 'bob')).toBe('operator');
  });

  it('returns observer when workspace missing', () => {
    const wm = new WorkspaceManager();
    expect(wm.getRole('nope', 'anyone')).toBe('observer');
  });
});

describe('WorkspaceManager.lazyResumeOrCreate', () => {
  function depsShell(overrides: Partial<LazyResumeDeps> = {}): { deps: LazyResumeDeps; calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = { isLive: [], hasPersistedSession: [], resume: [], sendInput: [], createLocal: [] };
    const deps: LazyResumeDeps = {
      isLive: (sid) => { calls.isLive.push(sid); return false; },
      hasPersistedSession: (sid) => { calls.hasPersistedSession.push(sid); return true; },
      resume: async (sid) => { calls.resume.push(sid); return null; },
      sendInput: async (sid, text, src) => { calls.sendInput.push({ sid, text, src }); },
      createLocal: async (opts) => { calls.createLocal.push(opts); return fakeSession('sess-new'); },
      ...overrides,
    };
    return { deps, calls };
  }

  it('branch 1: live active session → sendInput', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x' });
    wm.bindActiveSession(ws.id, 'sess-live');
    const { deps, calls } = depsShell({
      isLive: () => true,
      resume: async () => fakeSession('sess-live'),
    });
    const out = await wm.lazyResumeOrCreate(ws.id, 'hi', 'im', deps);
    expect(out.action).toBe('sent_to_live');
    expect(calls.sendInput).toEqual([{ sid: 'sess-live', text: 'hi', src: 'im' }]);
    expect(calls.createLocal).toEqual([]);
  });

  it('branch 2: stopped active session → resume + sendInput, rebinds activeSessionId', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x' });
    wm.bindActiveSession(ws.id, 'sess-old');
    const resumed = fakeSession('sess-old');
    const { deps, calls } = depsShell({
      isLive: () => false,
      resume: vi.fn(async (sid) => sid === 'sess-old' ? resumed : null) as LazyResumeDeps['resume'],
    });
    const out = await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', deps);
    expect(out.action).toBe('resumed');
    expect(out.session.id).toBe('sess-old');
    expect(calls.sendInput).toEqual([{ sid: 'sess-old', text: 'hello', src: 'im' }]);
    expect(wm.getActiveSessionId(ws.id)).toBe('sess-old');
  });

  it('branch 3: no active / cannot resume → createLocal with workspace defaults and binds', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/proj', defaults: { provider: 'codex' } });
    const { deps, calls } = depsShell();
    const out = await wm.lazyResumeOrCreate(ws.id, 'begin', 'cli', deps);
    expect(out.action).toBe('created');
    expect(out.session.id).toBe('sess-new');
    expect(calls.createLocal).toHaveLength(1);
    const createCall = calls.createLocal[0] as { workspaceId: string; workdir: string; provider: string; initialPrompt: string; source: string };
    expect(createCall.workspaceId).toBe(ws.id);
    expect(createCall.workdir).toBe('/proj');
    expect(createCall.provider).toBe('codex');
    expect(createCall.initialPrompt).toBe('begin');
    expect(createCall.source).toBe('cli');
    expect(wm.getActiveSessionId(ws.id)).toBe('sess-new');
  });

  it('throws for unknown workspace', async () => {
    const wm = new WorkspaceManager();
    const { deps } = depsShell();
    await expect(wm.lazyResumeOrCreate('missing', 'x', 'im', deps)).rejects.toThrow(/not found/);
  });
});

describe('WorkspaceManager.claimAdmin', () => {
  it('returns true and sets admin role when no admin exists', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x' });
    const claimed = wm.claimAdmin(ws.id, 'user-42');
    expect(claimed).toBe(true);
    expect(wm.getRole(ws.id, 'user-42')).toBe('admin');
  });

  it('returns false and does not change roles when an admin already exists', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x' });
    wm.setRole(ws.id, 'first-admin', 'admin');
    const claimed = wm.claimAdmin(ws.id, 'user-42');
    expect(claimed).toBe(false);
    expect(wm.getRole(ws.id, 'first-admin')).toBe('admin');
    expect(wm.getRole(ws.id, 'user-42')).toBe('observer');
  });

  it('is idempotent for the same userId already admin', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'x', workdir: '/x' });
    expect(wm.claimAdmin(ws.id, 'user-42')).toBe(true);
    expect(wm.claimAdmin(ws.id, 'user-42')).toBe(false);
  });

  it('throws on non-existent workspace', () => {
    const wm = new WorkspaceManager();
    expect(() => wm.claimAdmin('nope', 'user-42')).toThrow(/not found/);
  });
});

describe('WorkspaceManager.lazyResumeOrCreate resume passes sessionId to runtime.prepare', () => {
  let root: string;
  let persistence: SessionPersistence;
  let broker: PermissionBroker;
  let runtimes: FakeRuntime[];
  let sessionMgr: SessionManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-wsmgr-'));
    persistence = new SessionPersistence(root);
    await persistence.init();
    broker = new PermissionBroker();
    runtimes = [];
    sessionMgr = new SessionManager({
      persistence,
      broker,
      runtimeFactory: (provider) => {
        const r = new FakeRuntime(provider);
        runtimes.push(r);
        return r;
      },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lazyResumeOrCreate resume branch passes session id to runtime.prepare', async () => {
    // Create a session so a snapshot lands on disk.
    const original = await sessionMgr.createLocal({
      workspaceId: 'ws-resume', provider: 'claude', workdir: '/tmp', source: 'cli',
    });
    const sid = original.id;

    // Flush pending saves and force snapshot to idle so resumeLocal accepts it.
    await original.flushPendingPersistence();
    await persistence.saveSnapshot({ ...original.snapshotLegacy(), status: 'idle' });
    await sessionMgr.stop(sid);

    // Wire a fresh SessionManager pointing to the same disk so it can resume.
    const runtimes2: FakeRuntime[] = [];
    const sessionMgr2 = new SessionManager({
      persistence,
      broker,
      runtimeFactory: (provider) => {
        const r = new FakeRuntime(provider);
        runtimes2.push(r);
        return r;
      },
    });

    // Set up WorkspaceManager with the session pre-bound as active.
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'test-ws', workdir: '/tmp' });
    wm.bindActiveSession(ws.id, sid);

    const deps: LazyResumeDeps = {
      isLive: () => false,
      hasPersistedSession: (id) => persistence.hasSnapshot(id),
      resume: (id) => sessionMgr2.resumeLocal(id),
      sendInput: async () => { /* no-op */ },
      createLocal: async () => { throw new Error('should not create'); },
    };

    const out = await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', deps);
    expect(out.action).toBe('resumed');
    expect(out.session.id).toBe(sid);

    // The runtime created by resumeLocal must have received the session id.
    expect(runtimes2).toHaveLength(1);
    expect(runtimes2[0]!.resumeRequestedFor).toBe(sid);
  });
});

describe('isLive contract — precise active-only lookup (Spec X §I4 / §4.3)', () => {
  // The isLive predicate constructed in bootstrap.ts must use manager.get(id)
  // (precise lookup) and only return true when LocalSession.getStatus() === 'active'.
  // This test mirrors the predicate definition exactly.
  function makeIsLive(manager: SessionManager): (id: string) => boolean {
    return (id: string) => {
      const found = manager.get(id);
      if (found === undefined) return false;
      if (found.kind !== 'local') return false;
      return (found as LocalSession).getStatus() === 'active';
    };
  }

  let root: string;
  let persistence: SessionPersistence;
  let broker: PermissionBroker;
  let manager: SessionManager;
  let runtime: FakeRuntime;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-islive-'));
    persistence = new SessionPersistence(root);
    await persistence.init();
    broker = new PermissionBroker();
    manager = new SessionManager({
      persistence,
      broker,
      runtimeFactory: (provider) => {
        runtime = new FakeRuntime(provider);
        return runtime;
      },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('isLive returns true for active session, false for stopped', async () => {
    const isLive = makeIsLive(manager);
    const s = await manager.createLocal({
      workspaceId: 'ws-islive', provider: 'claude', workdir: '/tmp', source: 'cli',
    });
    // Immediately after create, session is active.
    expect(isLive(s.id)).toBe(true);

    // After stop, session is removed from manager map → isLive false.
    await manager.stop(s.id);
    expect(isLive(s.id)).toBe(false);
  });

  it('isLive returns false for unknown id', async () => {
    const isLive = makeIsLive(manager);
    expect(isLive('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('isLive returns false after session_complete transitions status to idle', async () => {
    const isLive = makeIsLive(manager);
    const s = await manager.createLocal({
      workspaceId: 'ws-islive2', provider: 'claude', workdir: '/tmp', source: 'cli',
    });
    expect(isLive(s.id)).toBe(true);

    // Fire session_complete through the runtime sink — transitions legacy status to 'idle'.
    runtime.emitEvent({ kind: 'session_complete', reason: 'end_turn', summary: '' });

    // Status is now 'idle'; isLive must be false (lazyResumeOrCreate must take resume branch).
    expect(isLive(s.id)).toBe(false);

    await manager.stop(s.id);
  });
});

describe('lazyResumeOrCreate — claude -r semantics (hasPersistedSession)', () => {
  it('takes resumed branch when activeSessionId set, isLive false, hasPersistedSession true', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 't', workdir: '/tmp/x' });
    wm.bindActiveSession(ws.id, 'sid-1');

    const branchEvents: Array<{ branch: string; sessionId: string; workspaceId: string }> = [];
    let resumeCalledWith = '';
    let createCalled = false;
    const resumed = fakeSession('sid-1');

    const out = await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', {
      isLive: () => false,
      hasPersistedSession: () => true,
      resume: async (id) => { resumeCalledWith = id; return resumed; },
      sendInput: async () => { /* no-op */ },
      createLocal: async () => { createCalled = true; return fakeSession('sid-new'); },
      onBranch: (info) => branchEvents.push(info),
    });

    expect(resumeCalledWith).toBe('sid-1');
    expect(createCalled).toBe(false);
    expect(branchEvents[0]?.branch).toBe('resumed');
    expect(out.action).toBe('resumed');
  });

  it('falls through to created when isLive false AND hasPersistedSession false', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 't', workdir: '/tmp/x' });
    wm.bindActiveSession(ws.id, 'sid-1');

    let createCalled = false;
    let resumeCalled = false;
    const created = fakeSession('sid-2');

    const out = await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', {
      isLive: () => false,
      hasPersistedSession: () => false,
      resume: async () => { resumeCalled = true; return null; },
      sendInput: async () => { /* no-op */ },
      createLocal: async () => { createCalled = true; return created; },
      onBranch: () => { /* ignore */ },
    });

    expect(createCalled).toBe(true);
    expect(resumeCalled).toBe(false);
    expect(out.action).toBe('created');
  });

  it('still takes live branch when isLive true (does not consult hasPersistedSession)', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 't', workdir: '/tmp/x' });
    wm.bindActiveSession(ws.id, 'sid-1');

    let sentTo = '';
    const live = fakeSession('sid-1');

    const out = await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', {
      isLive: () => true,
      hasPersistedSession: () => { throw new Error('should not be called when live'); },
      resume: async () => live, // fetchLiveOrThrow path
      sendInput: async (id) => { sentTo = id; },
      createLocal: async () => { throw new Error('should not create on live branch'); },
      onBranch: () => { /* ignore */ },
    });

    expect(sentTo).toBe('sid-1');
    expect(out.action).toBe('sent_to_live');
  });

  it('falls through to created when resume returns null (corrupt jsonl)', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 't', workdir: '/tmp/x' });
    wm.bindActiveSession(ws.id, 'sid-1');

    let createCalled = false;
    const created = fakeSession('sid-new');

    const out = await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', {
      isLive: () => false,
      hasPersistedSession: () => true,
      resume: async () => null,  // jsonl exists but resume failed
      sendInput: async () => { /* no-op */ },
      createLocal: async () => { createCalled = true; return created; },
      onBranch: () => { /* ignore */ },
    });

    expect(createCalled).toBe(true);
    expect(out.action).toBe('created');
  });

  it('catches resume thrown error and falls through to created with onResumeFailed', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 't', workdir: '/tmp/x' });
    wm.bindActiveSession(ws.id, 'sid-1');

    let createCalled = false;
    let failedInfo: { workspaceId: string; sdkSessionId: string; reason: string } | null = null;
    const fakeNewSession = fakeSession('sid-new');

    await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', {
      isLive: () => false,
      hasPersistedSession: () => true,
      resume: async () => { throw new Error('disk-eio'); },
      sendInput: async () => { /* no-op */ },
      createLocal: async () => { createCalled = true; return fakeNewSession; },
      onBranch: () => { /* ignore */ },
      onResumeFailed: (info) => { failedInfo = info; },
    } as never);

    expect(createCalled).toBe(true);
    expect(failedInfo).toMatchObject({ workspaceId: ws.id, sdkSessionId: 'sid-1', reason: 'disk-eio' });
  });

  it('fires onResumeFailed when resume returns null', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 't', workdir: '/tmp/x' });
    wm.bindActiveSession(ws.id, 'sid-1');

    let failedInfo: { workspaceId: string; sdkSessionId: string; reason: string } | null = null;
    const fakeNewSession = fakeSession('sid-new');

    await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', {
      isLive: () => false,
      hasPersistedSession: () => true,
      resume: async () => null,
      sendInput: async () => { /* no-op */ },
      createLocal: async () => fakeNewSession,
      onBranch: () => { /* ignore */ },
      onResumeFailed: (info) => { failedInfo = info; },
    } as never);

    expect(failedInfo).toMatchObject({ workspaceId: ws.id, sdkSessionId: 'sid-1', reason: 'resume returned null' });
  });

  it('after resume null, getActiveSessionId returns the freshly-created session id', async () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 't', workdir: '/tmp/x' });
    wm.bindActiveSession(ws.id, 'sid-1');

    const fakeNewSession = fakeSession('sid-new');
    await wm.lazyResumeOrCreate(ws.id, 'hello', 'im', {
      isLive: () => false,
      hasPersistedSession: () => true,
      resume: async () => null,
      sendInput: async () => { /* no-op */ },
      createLocal: async () => fakeNewSession,
      onBranch: () => { /* ignore */ },
    } as never);

    // bindActiveSession should have updated to the new id, not thrown WorkspaceConflictError
    expect(wm.getActiveSessionId(ws.id)).toBe('sid-new');
  });
});

describe('WorkspaceManager.createFromIM', () => {
  it('creates workspace + claims admin + adds primary binding', () => {
    const wm = new WorkspaceManager();
    const ws = wm.createFromIM({
      workdir: '/tmp/foo',
      adminUserId: 'u1',
      channelType: 'telegram',
      chatId: 'c1',
    });
    expect(ws.workdir).toBe('/tmp/foo');
    expect(ws.name).toBe('foo'); // basename
    expect(wm.getRole(ws.id, 'u1')).toBe('admin');
    expect(ws.bindings).toHaveLength(1);
    expect(ws.bindings[0]).toMatchObject({
      channelType: 'telegram',
      chatId: 'c1',
      role: 'primary',
    });
  });

  it('respects custom name override', () => {
    const wm = new WorkspaceManager();
    const ws = wm.createFromIM({
      workdir: '/tmp/foo',
      adminUserId: 'u1',
      channelType: 'telegram',
      chatId: 'c1',
      name: 'custom-name',
    });
    expect(ws.name).toBe('custom-name');
  });

  it('threadId carries through to binding', () => {
    const wm = new WorkspaceManager();
    const ws = wm.createFromIM({
      workdir: '/tmp/foo',
      adminUserId: 'u1',
      channelType: 'telegram',
      chatId: 'c1',
      threadId: 't42',
    });
    expect(ws.bindings[0]?.threadId).toBe('t42');
  });

  it('respects defaults override', () => {
    const wm = new WorkspaceManager();
    const ws = wm.createFromIM({
      workdir: '/tmp/foo',
      adminUserId: 'u1',
      channelType: 'telegram',
      chatId: 'c1',
      defaults: { provider: 'codex' },
    });
    expect(ws.defaults.provider).toBe('codex');
  });

  it('findByChat picks up the new workspace immediately', () => {
    const wm = new WorkspaceManager();
    wm.createFromIM({
      workdir: '/tmp/foo',
      adminUserId: 'u1',
      channelType: 'telegram',
      chatId: 'c1',
    });
    const found = wm.findByChat('telegram', 'c1');
    expect(found?.workdir).toBe('/tmp/foo');
  });
});
