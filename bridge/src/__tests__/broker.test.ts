import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { ChannelType } from '../channels/types.js';
import type { NotificationRenderer } from '../renderers/types.js';
import { TelegramRenderer } from '../renderers/telegram.js';

function createMockAdapter(): BaseChannelAdapter {
  return {
    channelType: 'telegram',
    send: vi.fn().mockResolvedValue({ messageId: '42', success: true }),
    editMessage: vi.fn(),
    start: vi.fn(), stop: vi.fn(), consumeOne: vi.fn(),
    validateConfig: vi.fn(), isAuthorized: vi.fn(),
  } as any;
}

function createRenderers(): Map<ChannelType, NotificationRenderer> {
  return new Map<ChannelType, NotificationRenderer>([
    ['telegram', new TelegramRenderer()],
  ]);
}

describe('PermissionBroker', () => {
  let broker: PermissionBroker;
  let gateway: PendingPermissions;
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    gateway = new PendingPermissions();
    adapter = createMockAdapter();
    broker = new PermissionBroker(gateway, 'https://termlive.example.com', createRenderers());
  });

  it('forwards permission request to adapter via send with buttons', async () => {
    await broker.forwardPermissionRequest(
      { permissionRequestId: 'perm1', toolName: 'Edit', toolInput: { file: 'src/auth.ts' } },
      () => 'chat123',
      [adapter]
    );

    expect(adapter.send).toHaveBeenCalledOnce();
    const [chatId, rendered] = (adapter.send as any).mock.calls[0];
    expect(chatId).toBe('chat123');
    expect(rendered.buttons).toHaveLength(3); // Yes, No, Stop session
    expect(rendered.buttons[0].callbackData).toBe('perm:allow:perm1');
    expect(rendered.buttons[1].callbackData).toBe('perm:deny:perm1');
    expect(rendered.buttons[2].callbackData).toBe('perm:stop:perm1');
    // Should include HTML content (rendered by TelegramRenderer)
    expect(rendered.html).toContain('Permission Required');
  });

  it('truncates long tool input to 300 chars', async () => {
    const longInput = 'x'.repeat(500);
    await broker.forwardPermissionRequest(
      { permissionRequestId: 'p1', toolName: 'Edit', toolInput: longInput },
      () => 'chat1',
      [adapter]
    );

    const [, rendered] = (adapter.send as any).mock.calls[0];
    const text = rendered.html || '';
    // The full 500-char input should not appear
    expect(text.length).toBeLessThan(600);
  });

  it('handlePermissionCallback resolves allow', () => {
    gateway.waitFor('perm1');
    const result = broker.handlePermissionCallback('perm:allow:perm1');
    expect(result).toBe(true);
  });

  it('handlePermissionCallback resolves deny', () => {
    gateway.waitFor('perm1');
    const result = broker.handlePermissionCallback('perm:deny:perm1');
    expect(result).toBe(true);
  });

  it('handlePermissionCallback returns false for unknown', () => {
    expect(broker.handlePermissionCallback('perm:allow:unknown')).toBe(false);
  });

  it('parses callback data format correctly', () => {
    gateway.waitFor('abc-123');
    expect(broker.handlePermissionCallback('perm:allow:abc-123')).toBe(true);
  });
});
