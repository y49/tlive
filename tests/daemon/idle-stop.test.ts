// tests/daemon/idle-stop.test.ts
//
// Verifies the per-session idle-stop tick:
//   - sessions older than idleHours are stopped
//   - fresh sessions are left alone
//   - a skip() caller exempts a session for one tick

import { describe, it, expect } from 'vitest';
import { startIdleStop } from '../../src/daemon/idle-stop.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import type { SessionManager } from '../../src/session/manager.js';
import type { SessionPersistence, SessionMeta } from '../../src/session/persistence.js';
import type { SessionInfo, OwnerChat } from '../../src/session/types.js';

function fakeSessionManager(list: SessionInfo[], stopped: string[]): SessionManager {
  return {
    listInfo(): SessionInfo[] { return list; },
    async stop(id: string) { stopped.push(id); },
  } as unknown as SessionManager;
}

function fakePersistence(metas: SessionMeta[]): SessionPersistence {
  return {
    async loadMeta(id: string) { return metas.find((m) => m.sdkSessionId === id) ?? null; },
    async writeMeta(_m: SessionMeta) { /* noop */ },
  } as unknown as SessionPersistence;
}

function mkInfo(id: string, lastActivityAt: number, ownerChat?: OwnerChat): SessionInfo {
  return {
    id,
    shortAlias: id.slice(0, 8),
    kind: 'local',
    provider: 'claude',
    workspaceId: 'ws',
    workdir: '/x',
    title: undefined,
    status: { phase: 'running' } as never,
    cost: { totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    createdAt: 0,
    lastActivityAt,
    ownerChat,
  };
}

function mkMeta(id: string): SessionMeta {
  return {
    sdkSessionId: id,
    provider: 'claude',
    workspaceId: 'ws',
    workdir: '/x',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'running',
    cost: { totalCost: 0, inputTokens: 0, outputTokens: 0 },
    pendingPermissions: [],
    pendingAskQuestions: [],
    pendingElicitations: [],
  };
}

describe('startIdleStop', () => {
  it('stops sessions past the idle threshold', async () => {
    const now = 10 * 24 * 60 * 60 * 1000; // day 10
    const infos = [
      mkInfo('sid-old', now - 48 * 60 * 60 * 1000),   // 48h
      mkInfo('sid-new', now - 1 * 60 * 60 * 1000),    //  1h
    ];
    const stopped: string[] = [];
    const handle = startIdleStop({
      sessions: fakeSessionManager(infos, stopped),
      persistence: fakePersistence(infos.map((i) => mkMeta(i.id))),
      idleHours: 24,
      tickMs: 1_000,
      now: () => now,
    });
    const out = await handle.tickOnce();
    handle.stop();
    expect(out).toEqual(['sid-old']);
    expect(stopped).toEqual(['sid-old']);
  });

  it('clears binding active session via clearActiveSession after stopping', async () => {
    const now = 10 * 24 * 60 * 60 * 1000; // day 10
    const wm = new WorkspaceManager({ persistPath: null });
    const ws = wm.create({ name: 't', workdir: '/tmp/t' });
    wm.bindChat({workspaceId: ws.id,  channelType: 'telegram', chatId: 'c1' });
    wm.bindActiveSession('telegram', 'c1', 'sid-1');

    const infos = [
      mkInfo('sid-1', now - 25 * 60 * 60 * 1000, { channelType: 'telegram', chatId: 'c1' }),
    ];
    const stopped: string[] = [];
    const handle = startIdleStop({
      sessions: fakeSessionManager(infos, stopped),
      persistence: fakePersistence(infos.map((i) => mkMeta(i.id))),
      workspaces: wm,
      idleHours: 24,
      tickMs: 1_000,
      now: () => now,
    });
    const out = await handle.tickOnce();
    handle.stop();
    expect(out).toEqual(['sid-1']);
    expect(stopped).toEqual(['sid-1']);
    expect(wm.getActiveSessionId('telegram', 'c1')).toBeNull();
  });

  it('skip() exempts a session for the next tick only', async () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const infos = [mkInfo('sid-x', now - 48 * 60 * 60 * 1000)];
    const stopped: string[] = [];
    const handle = startIdleStop({
      sessions: fakeSessionManager(infos, stopped),
      persistence: fakePersistence(infos.map((i) => mkMeta(i.id))),
      idleHours: 24,
      tickMs: 1_000,
      now: () => now,
    });
    handle.skip('sid-x');
    const out1 = await handle.tickOnce();
    const out2 = await handle.tickOnce();
    handle.stop();
    expect(out1).toEqual([]);
    expect(out2).toEqual(['sid-x']);
  });
});
