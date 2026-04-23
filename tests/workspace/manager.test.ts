// tests/workspace/manager.test.ts

import { describe, it, expect, vi } from 'vitest';
import { WorkspaceManager, WorkspaceConflictError, type LazyResumeDeps } from '../../src/workspace/manager.js';
import type { SessionLike } from '../../src/session/types.js';

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
    expect(wm.findByChat('discord', 'c1')).toBeUndefined();
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
    const calls: Record<string, unknown[]> = { isLive: [], resume: [], sendInput: [], createLocal: [] };
    const deps: LazyResumeDeps = {
      isLive: (sid) => { calls.isLive.push(sid); return false; },
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
