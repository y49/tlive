import { describe, it, expect } from 'vitest';
import { buildIpcDispatcher } from '../../src/ipc/dispatcher.js';
import type { IpcRequest, IpcResponse } from '../../src/ipc/protocol.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';

describe('IPC dispatcher — workspace.list / .remove', () => {
  function setup() {
    const wm = new WorkspaceManager();
    const responses: IpcResponse[] = [];
    const handler = buildIpcDispatcher({
      sessions: {} as never,
      workspaces: wm,
      persistence: {} as never,
      startedAt: Date.now(),
      requestDaemonShutdown: () => undefined,
    });
    return {
      wm,
      responses,
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
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: 'c1', role: 'primary' });
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
});
