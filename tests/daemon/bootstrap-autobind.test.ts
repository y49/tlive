import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapDaemon } from '../../src/daemon/bootstrap.js';

describe('bootstrap auto-bind + claim-admin', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tlive-boot-'));
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('claims admin and binds telegram chatId on first start', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w', adminUserId: '12345' }],
      channels: { telegram: { token: 'fake-token', chatId: '12345' } },
    }), 'utf8');

    const handle = await bootstrapDaemon({
      home,
      startAdapters: false,
      adapterFactory: () => null,
    });

    const persisted = JSON.parse(readFileSync(join(home, 'workspaces.json'), 'utf8'));
    const ws = persisted.workspaces[0];
    expect(ws.roles['12345']).toBe('admin');
    expect(ws.bindings).toEqual([
      expect.objectContaining({ channelType: 'telegram', chatId: '12345', role: 'primary' }),
    ]);

    await handle.shutdown();
  });

  it('is idempotent: second boot does not duplicate bindings or change roles', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w', adminUserId: '12345' }],
      channels: { telegram: { token: 'fake-token', chatId: '12345' } },
    }), 'utf8');

    const h1 = await bootstrapDaemon({ home, startAdapters: false, adapterFactory: () => null });
    await h1.shutdown();
    const h2 = await bootstrapDaemon({ home, startAdapters: false, adapterFactory: () => null });
    await h2.shutdown();

    const persisted = JSON.parse(readFileSync(join(home, 'workspaces.json'), 'utf8'));
    const ws = persisted.workspaces[0];
    expect(ws.bindings).toHaveLength(1);
    expect(Object.keys(ws.roles)).toEqual(['12345']);
  });

  it('does not promote when adminUserId is omitted', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w' }],
      channels: { telegram: { token: 'fake-token', chatId: '12345' } },
    }), 'utf8');

    const h = await bootstrapDaemon({ home, startAdapters: false, adapterFactory: () => null });
    const persisted = JSON.parse(readFileSync(join(home, 'workspaces.json'), 'utf8'));
    const ws = persisted.workspaces[0];
    expect(ws.roles).toEqual({});
    expect(ws.bindings).toEqual([
      expect.objectContaining({ channelType: 'telegram', chatId: '12345', role: 'primary' }),
    ]);
    await h.shutdown();
  });
});
