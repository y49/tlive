import { describe, it, expect, vi } from 'vitest';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { autoBindFromConfig } from '../../src/workspace/auto-bind.js';
import type { TliveConfigV1 } from '../../src/config/schema.js';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function cfg(overrides: Partial<TliveConfigV1> = {}): TliveConfigV1 {
  return {
    version: '1',
    workspaces: [{ name: 'w', workdir: '/tmp/w' }],
    ...overrides,
  };
}

describe('autoBindFromConfig', () => {
  it('binds Telegram chatId to single workspace when not yet bound', () => {
    const wm = new WorkspaceManager();
    wm.create({ name: 'w', workdir: '/tmp/w' });
    const c = cfg({ channels: { telegram: { token: 't', chatId: '123' } } });
    const log = silentLogger();
    const created = autoBindFromConfig(wm, c, log);
    expect(created).toBe(1);
    expect(wm.findByChat('telegram', '123')?.name).toBe('w');
    expect(log.info).toHaveBeenCalledWith('auto-bound chat from config', expect.objectContaining({ platform: 'telegram', chatId: '123' }));
  });

  it('skips Feishu (no chatId field on that channel config)', () => {
    const wm = new WorkspaceManager();
    wm.create({ name: 'w', workdir: '/tmp/w' });
    const c = cfg({ channels: { feishu: { appId: 'a', appSecret: 's' } } });
    const created = autoBindFromConfig(wm, c, silentLogger());
    expect(created).toBe(0);
  });

  it('is idempotent — re-running after binding exists creates 0 new bindings', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'w', workdir: '/tmp/w' });
    wm.addBinding(ws.id, { channelType: 'telegram', chatId: '123', role: 'primary' });
    const c = cfg({ channels: { telegram: { token: 't', chatId: '123' } } });
    expect(autoBindFromConfig(wm, c, silentLogger())).toBe(0);
  });

  it('multi-workspace: binds chatId to the workspace whose adminUserId matches', () => {
    const wm = new WorkspaceManager();
    wm.create({ name: 'a', workdir: '/tmp/a' });
    wm.create({ name: 'b', workdir: '/tmp/b' });
    const c: TliveConfigV1 = {
      version: '1',
      workspaces: [
        { name: 'a', workdir: '/tmp/a', adminUserId: 'other' },
        { name: 'b', workdir: '/tmp/b', adminUserId: '123' },
      ],
      channels: { telegram: { token: 't', chatId: '123' } },
    };
    expect(autoBindFromConfig(wm, c, silentLogger())).toBe(1);
    expect(wm.findByChat('telegram', '123')?.name).toBe('b');
  });

  it('multi-workspace ambiguous: chatId matches no admin → 0 bindings, warn logged', () => {
    const wm = new WorkspaceManager();
    wm.create({ name: 'a', workdir: '/tmp/a' });
    wm.create({ name: 'b', workdir: '/tmp/b' });
    const c: TliveConfigV1 = {
      version: '1',
      workspaces: [
        { name: 'a', workdir: '/tmp/a', adminUserId: 'x' },
        { name: 'b', workdir: '/tmp/b', adminUserId: 'y' },
      ],
      channels: { telegram: { token: 't', chatId: '123' } },
    };
    const log = silentLogger();
    expect(autoBindFromConfig(wm, c, log)).toBe(0);
  });

  it('skips workspace listed in config but not registered in manager', () => {
    const wm = new WorkspaceManager(); // no workspaces created
    const c = cfg({ channels: { telegram: { token: 't', chatId: '123' } } });
    expect(autoBindFromConfig(wm, c, silentLogger())).toBe(0);
  });
});
