import { describe, it, expect } from 'vitest';
import { buildIpcDispatcher } from '../../src/ipc/dispatcher.js';
import type { IpcRequest, IpcResponse } from '../../src/ipc/protocol.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';

describe('IPC dispatcher — workspace.list / .remove', () => {
  function setup() {
    const wm = new WorkspaceManager();
    const responses: IpcResponse[] = [];
    const stopCalls: string[] = [];
    const liveSessions = new Map<string, { kind: 'local'; stop: () => Promise<void> }>();
    const sessionsStub = {
      get: (id: string) => liveSessions.get(id),
      stop: async (id: string) => { stopCalls.push(id); liveSessions.delete(id); },
    };
    const handler = buildIpcDispatcher({
      sessions: sessionsStub as never,
      workspaces: wm,
      persistence: {} as never,
      startedAt: Date.now(),
      requestDaemonShutdown: () => undefined,
    });
    return {
      wm,
      responses,
      stopCalls,
      addLiveSession: (id: string, opts?: { failStop?: boolean }) => {
        liveSessions.set(id, {
          kind: 'local',
          stop: async () => {
            stopCalls.push(id);
            if (opts?.failStop) throw new Error('boom');
            liveSessions.delete(id);
          },
        });
      },
      send: async (req: IpcRequest) => {
        await handler(req, (r) => responses.push(r));
      },
    };
  }

  it('workspace.list returns empty list when no workspaces', async () => {
    const { send, responses } = setup();
    await send({ kind: 'workspace.list' });
    expect(responses[0]).toMatchObject({ kind: 'workspace.list', workspaces: [] });
  });

  it('workspace.list returns workspace info with admin + binding counts', async () => {
    const { wm, send, responses } = setup();
    const ws = wm.create({ name: 'foo', workdir: '/p/f' });
    wm.setRole(ws.id, 'u-admin', 'admin');
    wm.bindChat({workspaceId: ws.id,  channelType: 'telegram', chatId: 'c1' });
    await send({ kind: 'workspace.list' });
    expect(responses[0]).toMatchObject({
      kind: 'workspace.list',
      workspaces: [{
        id: ws.id,
        name: 'foo',
        workdir: '/p/f',
        admin: 'u-admin',
        bindings: 1,
        activeSessionId: null,
      }],
    });
  });

  it('workspace.list returns admin: null when unclaimed', async () => {
    const { wm, send, responses } = setup();
    wm.create({ name: 'foo', workdir: '/p/f' });
    await send({ kind: 'workspace.list' });
    const r = responses[0];
    if (r.kind !== 'workspace.list') throw new Error('expected workspace.list');
    expect(r.workspaces[0]!.admin).toBeNull();
  });

  it('workspace.remove by name succeeds', async () => {
    const { wm, send, responses } = setup();
    wm.create({ name: 'foo', workdir: '/p/f' });
    await send({ kind: 'workspace.remove', idOrName: 'foo' });
    expect(responses[0]).toMatchObject({ kind: 'workspace.removed', ok: true });
    expect(wm.list()).toHaveLength(0);
  });

  it('workspace.remove by id succeeds', async () => {
    const { wm, send, responses } = setup();
    const ws = wm.create({ name: 'foo', workdir: '/p/f' });
    await send({ kind: 'workspace.remove', idOrName: ws.id });
    expect(responses[0]).toMatchObject({ kind: 'workspace.removed', ok: true });
    expect(wm.list()).toHaveLength(0);
  });

  it('workspace.remove non-existent returns ok: false with reason', async () => {
    const { send, responses } = setup();
    await send({ kind: 'workspace.remove', idOrName: 'nope' });
    expect(responses[0]).toMatchObject({
      kind: 'workspace.removed',
      ok: false,
      reason: expect.stringContaining('not found'),
    });
  });

  it('workspace.remove stops active session before deletion', async () => {
    const { wm, send, responses, stopCalls, addLiveSession } = setup();
    const ws = wm.create({ name: 'foo', workdir: '/p/f' });
    const sdkId = 'sid-foo';
    wm.bindChat({workspaceId: ws.id,  channelType: 'telegram', chatId: 'c1' });
    wm.bindActiveSession('telegram', 'c1', sdkId);
    addLiveSession(sdkId);

    await send({ kind: 'workspace.remove', idOrName: 'foo' });
    expect(responses[0]).toMatchObject({ kind: 'workspace.removed', ok: true });
    expect(wm.list()).toHaveLength(0);
    expect(stopCalls).toEqual([sdkId]);
  });

  it('workspace.remove without active session does not attempt stop', async () => {
    const { wm, send, responses, stopCalls } = setup();
    wm.create({ name: 'foo', workdir: '/p/f' });
    await send({ kind: 'workspace.remove', idOrName: 'foo' });
    expect(responses[0]).toMatchObject({ kind: 'workspace.removed', ok: true });
    expect(wm.list()).toHaveLength(0);
    expect(stopCalls).toEqual([]);
  });

  it('workspace.remove proceeds with deletion even if session stop throws', async () => {
    const { wm, send, responses, stopCalls, addLiveSession } = setup();
    const ws = wm.create({ name: 'foo', workdir: '/p/f' });
    const sdkId = 'sid-foo';
    wm.bindChat({workspaceId: ws.id,  channelType: 'telegram', chatId: 'c1' });
    wm.bindActiveSession('telegram', 'c1', sdkId);
    addLiveSession(sdkId, { failStop: true });

    await send({ kind: 'workspace.remove', idOrName: 'foo' });
    expect(responses[0]).toMatchObject({ kind: 'workspace.removed', ok: true });
    expect(wm.list()).toHaveLength(0);
    expect(stopCalls).toEqual([sdkId]);
  });
});
