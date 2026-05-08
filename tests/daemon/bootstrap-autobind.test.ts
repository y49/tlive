import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapDaemon } from '../../src/daemon/bootstrap.js';

describe('bootstrap auto-bind (chat-trust, v2 schema)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tlive-boot-'));
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('binds telegram chatId from config on first start', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w' }],
      channels: { telegram: { token: 'fake-token', chatId: '12345' } },
    }), 'utf8');

    const handle = await bootstrapDaemon({
      home,
      startAdapters: false,
      adapterFactory: () => null,
    });

    const persisted = JSON.parse(readFileSync(join(home, 'workspaces.json'), 'utf8'));
    expect(persisted.version).toBe(2);
    // chat-trust: no roles on workspace
    const ws = persisted.workspaces[0];
    expect(ws.roles).toBeUndefined();
    // chatInstances array has the auto-bind entry
    expect(persisted.chatInstances).toHaveLength(1);
    expect(persisted.chatInstances[0]).toMatchObject({
      channelType: 'telegram',
      chatId: '12345',
    });

    await handle.shutdown();
  });

  it('is idempotent: second boot does not duplicate chatInstances', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w' }],
      channels: { telegram: { token: 'fake-token', chatId: '12345' } },
    }), 'utf8');

    const h1 = await bootstrapDaemon({ home, startAdapters: false, adapterFactory: () => null });
    await h1.shutdown();
    const h2 = await bootstrapDaemon({ home, startAdapters: false, adapterFactory: () => null });
    await h2.shutdown();

    const persisted = JSON.parse(readFileSync(join(home, 'workspaces.json'), 'utf8'));
    expect(persisted.chatInstances).toHaveLength(1);
  });

  it('does not bind when no chatId is set in channels', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w' }],
      channels: { telegram: { token: 'fake-token' } },
    }), 'utf8');

    const h = await bootstrapDaemon({ home, startAdapters: false, adapterFactory: () => null });
    const persisted = JSON.parse(readFileSync(join(home, 'workspaces.json'), 'utf8'));
    expect(persisted.chatInstances ?? []).toHaveLength(0);
    await h.shutdown();
  });
});
