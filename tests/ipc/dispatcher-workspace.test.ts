import { describe, it, expect } from 'vitest';
import { buildIpcDispatcher } from '../../src/ipc/dispatcher.js';
import type { IpcRequest, IpcResponse } from '../../src/ipc/protocol.js';
import type { PlatformAdapter } from '../../src/platform/types.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';

describe('IPC dispatcher — workspace.list / .remove', () => {
  interface SetupOpts {
    /** Fake adapters to inject (keyed by channelType). */
    adapters?: Record<string, Partial<PlatformAdapter> & { sendCalls?: Array<{ chatId: string; text: string }> }>;
  }

  function setup(opts: SetupOpts = {}) {
    const wm = new WorkspaceManager();
    const responses: IpcResponse[] = [];
    const stopCalls: string[] = [];
    const liveSessions = new Map<string, { kind: 'local'; stop: () => Promise<void> }>();
    const sessionsStub = {
      get: (id: string) => liveSessions.get(id),
      stop: async (id: string) => { stopCalls.push(id); liveSessions.delete(id); },
    };

    // Build fake adapter map (records send calls for assertions).
    const adapterSendCalls: Array<{ channelType: string; chatId: string; text: string }> = [];
    const fakeAdapters: Record<string, PlatformAdapter> = {};
    for (const [ct, stub] of Object.entries(opts.adapters ?? {})) {
      fakeAdapters[ct] = {
        channelType: ct as never,
        start: async () => undefined,
        stop: async () => undefined,
        send: async (msg) => {
          adapterSendCalls.push({ channelType: ct, chatId: msg.chatId, text: msg.text ?? '' });
          return 'fake-msg-id';
        },
        edit: async () => undefined,
        delete: async () => undefined,
        pin: async () => undefined,
        setReaction: async () => undefined,
        sendAttachment: async () => 'fake-attach-id',
        downloadAttachment: async () => Buffer.alloc(0),
        onInbound: () => () => undefined,
        ...stub,
      } as PlatformAdapter;
    }

    const handler = buildIpcDispatcher({
      sessions: sessionsStub as never,
      workspaces: wm,
      persistence: {} as never,
      startedAt: Date.now(),
      requestDaemonShutdown: () => undefined,
      ...(Object.keys(fakeAdapters).length > 0 ? { adapters: fakeAdapters as never } : {}),
    });
    return {
      wm,
      responses,
      stopCalls,
      adapterSendCalls,
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

  it('workspace.list returns workspace info with chatInstance counts', async () => {
    const { wm, send, responses } = setup();
    const ws = wm.create({ name: 'foo', workdir: '/p/f' });
    wm.bindChat({workspaceId: ws.id,  channelType: 'telegram', chatId: 'c1' });
    await send({ kind: 'workspace.list' });
    expect(responses[0]).toMatchObject({
      kind: 'workspace.list',
      workspaces: [{
        id: ws.id,
        name: 'foo',
        workdir: '/p/f',
        chatInstances: 1,
        activeSessionId: null,
      }],
    });
  });

  it('workspace.list returns chatInstances: 0 when no chats bound', async () => {
    const { wm, send, responses } = setup();
    wm.create({ name: 'foo', workdir: '/p/f' });
    await send({ kind: 'workspace.list' });
    const r = responses[0];
    if (r.kind !== 'workspace.list') throw new Error('expected workspace.list');
    expect(r.workspaces[0]!.chatInstances).toBe(0);
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

    await send({ kind: 'workspace.remove', idOrName: 'foo', force: true });
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

    await send({ kind: 'workspace.remove', idOrName: 'foo', force: true });
    expect(responses[0]).toMatchObject({ kind: 'workspace.removed', ok: true });
    expect(wm.list()).toHaveLength(0);
    expect(stopCalls).toEqual([sdkId]);
  });

  it('workspace.remove with force=false and bound chat returns ok:false with reason', async () => {
    const { wm, send, responses } = setup();
    const ws = wm.create({ name: 'foo', workdir: '/p/f' });
    wm.bindChat({ workspaceId: ws.id, channelType: 'telegram', chatId: 'c1' });

    await send({ kind: 'workspace.remove', idOrName: 'foo', force: false });
    expect(responses[0]).toMatchObject({
      kind: 'workspace.removed',
      ok: false,
      reason: expect.stringContaining('bound'),
    });
    // Workspace must NOT have been deleted.
    expect(wm.list()).toHaveLength(1);
  });

  it('workspace.remove with force=true and bound chat cascade-stops + IM-notifies each chat', async () => {
    const { wm, send, responses, stopCalls, adapterSendCalls, addLiveSession } = setup({
      adapters: { telegram: {} },
    });
    const ws = wm.create({ name: 'myws', workdir: '/p/m' });
    const sdkId = 'sid-myws';
    wm.bindChat({ workspaceId: ws.id, channelType: 'telegram', chatId: 'chat-42' });
    wm.bindActiveSession('telegram', 'chat-42', sdkId);
    addLiveSession(sdkId);

    await send({ kind: 'workspace.remove', idOrName: 'myws', force: true });
    expect(responses[0]).toMatchObject({ kind: 'workspace.removed', ok: true });
    expect(wm.list()).toHaveLength(0);
    // Session must have been stopped.
    expect(stopCalls).toContain(sdkId);
    // Adapter.send must have been called for the removed chat.
    expect(adapterSendCalls).toHaveLength(1);
    expect(adapterSendCalls[0]).toMatchObject({
      channelType: 'telegram',
      chatId: 'chat-42',
      text: expect.stringContaining('myws'),
    });
  });
});
