import { describe, it, expect } from 'vitest';
import { buildIpcDispatcher } from '../../src/ipc/dispatcher.js';
import type { IpcResponse } from '../../src/ipc/protocol.js';
import type { PlatformAdapter } from '../../src/platform/types.js';

function fakeAdapter(connected: boolean | null): PlatformAdapter {
  return {
    channelType: 'feishu',
    async start() {},
    async stop() {},
    async send() { return 'mid'; },
    async edit() {},
    async delete() {},
    async pin() {},
    async setReaction() {},
    async sendAttachment() { return 'mid'; },
    async downloadAttachment() { return Buffer.from(''); },
    onInbound() { return () => undefined; },
    isConnected: () => connected,
  } as unknown as PlatformAdapter;
}

function captureReply(): { reply: (r: IpcResponse) => void; got: IpcResponse[] } {
  const got: IpcResponse[] = [];
  return { reply: (r) => got.push(r), got };
}

describe('daemon.status adapters field', () => {
  const baseDeps = {
    sessions: { listInfo: () => [] } as never,
    workspaces: {} as never,
    persistence: {} as never,
    startedAt: Date.now() - 5000,
    requestDaemonShutdown: () => undefined,
  };

  it('reports connected/idle per adapter', async () => {
    const dispatcher = buildIpcDispatcher({
      ...baseDeps,
      adapters: {
        telegram: fakeAdapter(null),         // no isConnected, treated as 'connected'
        feishu: fakeAdapter(true),
      },
    });
    const { reply, got } = captureReply();
    await dispatcher({ kind: 'daemon.status' }, reply);
    expect(got[0]).toMatchObject({
      kind: 'daemon.status',
      adapters: { telegram: 'connected', feishu: 'connected' },
    });
  });

  it('feishu reports idle when isConnected returns false', async () => {
    const dispatcher = buildIpcDispatcher({
      ...baseDeps,
      adapters: { feishu: fakeAdapter(false) },
    });
    const { reply, got } = captureReply();
    await dispatcher({ kind: 'daemon.status' }, reply);
    expect(got[0]).toMatchObject({ adapters: { feishu: 'idle' } });
  });

  it('omits adapters field entirely when no adapters passed (back-compat)', async () => {
    const dispatcher = buildIpcDispatcher(baseDeps);
    const { reply, got } = captureReply();
    await dispatcher({ kind: 'daemon.status' }, reply);
    expect(got[0]).toMatchObject({ kind: 'daemon.status' });
    if (got[0].kind === 'daemon.status') {
      expect(got[0].adapters).toBeUndefined();
    }
  });
});
