import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookEngine } from '../engine/hook-engine.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { PermissionCoordinator } from '../engine/permission-coordinator.js';

vi.mock('../formatting/index.js', () => ({
  formatNotification: vi.fn().mockImplementation(({ type, title, summary, terminalUrl }) => ({
    text: title,
    html: title,
    embed: undefined,
    feishuHeader: undefined,
  })),
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({ publicUrl: '', port: 4590 }),
}));

function mockAdapter(channelType = 'telegram'): BaseChannelAdapter {
  return {
    channelType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    consumeOne: vi.fn().mockReturnValue(null),
    send: vi.fn().mockResolvedValue({ messageId: 'msg-42', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    validateConfig: vi.fn().mockReturnValue(null),
    isAuthorized: vi.fn().mockReturnValue(true),
  } as any;
}

function mockPermissions(): PermissionCoordinator {
  return {
    trackHookMessage: vi.fn(),
  } as any;
}

describe('HookEngine', () => {
  let engine: HookEngine;
  let permissions: PermissionCoordinator;
  let adapter: BaseChannelAdapter;
  let formatNotification: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    permissions = mockPermissions();
    adapter = mockAdapter();

    const formatting = await import('../formatting/index.js');
    formatNotification = vi.mocked(formatting.formatNotification);
    formatNotification.mockImplementation(({ type, title, summary, terminalUrl }: any) => ({
      text: title,
      html: title,
      embed: undefined,
      feishuHeader: undefined,
    }));
  });

  function createEngine(opts: { coreAvailable?: boolean; token?: string; localIP?: string } = {}) {
    return new HookEngine(
      permissions,
      () => opts.coreAvailable ?? false,
      opts.token ?? 'test-token',
      () => opts.localIP ?? '127.0.0.1',
    );
  }

  describe('stop notification', () => {
    it('builds title with context suffix and truncates summary at 3000 chars', async () => {
      engine = createEngine();
      const longMessage = 'x'.repeat(4000);

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_session_id: 'session-abc123',
        tlive_cwd: '/home/user/my-project',
        last_assistant_message: longMessage,
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stop',
          title: 'Terminal · my-project · #abc123',
          summary: 'x'.repeat(2997) + '...',
        }),
        'telegram',
      );
    });

    it('uses last_output as fallback when last_assistant_message is missing', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        last_output: 'some output',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stop',
          summary: 'some output',
        }),
        'telegram',
      );
    });

    it('sets summary to undefined when no assistant message or output', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stop',
          summary: undefined,
        }),
        'telegram',
      );
    });
  });

  describe('idle_prompt notification', () => {
    it('builds title with message', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
        tlive_session_id: 'sess-xyz789',
        tlive_cwd: '/home/user/app',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'idle_prompt',
          title: 'Terminal · app · #xyz789 · Claude is waiting for your input',
        }),
        'telegram',
      );
    });

    it('uses default message when hook.message is missing', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        notification_type: 'idle_prompt',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'idle_prompt',
          title: 'Terminal · Waiting for input...',
        }),
        'telegram',
      );
    });
  });

  describe('generic notification', () => {
    it('uses hook.message as title', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        message: 'Something happened',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'generic',
          title: 'Something happened',
        }),
        'telegram',
      );
    });

    it('falls back to "Notification" when message is missing', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {});

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'generic',
          title: 'Notification',
        }),
        'telegram',
      );
    });
  });

  describe('context suffix', () => {
    it('includes project name from cwd and short session ID', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_cwd: '/home/user/my-awesome-project',
        tlive_session_id: 'abcdef123456',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Terminal · my-awesome-project · #123456',
        }),
        'telegram',
      );
    });

    it('omits suffix when cwd and session_id are both missing', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Terminal',
        }),
        'telegram',
      );
    });
  });

  describe('terminal URL', () => {
    it('generates URL when coreAvailable is true and session_id exists', async () => {
      engine = createEngine({ coreAvailable: true, token: 'my-token', localIP: '192.168.1.10' });

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_session_id: 'sess-001',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalUrl: 'http://192.168.1.10:4590/terminal.html?id=sess-001&token=my-token',
        }),
        'telegram',
      );
    });

    it('does not generate URL when coreAvailable is false', async () => {
      engine = createEngine({ coreAvailable: false });

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_session_id: 'sess-001',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalUrl: undefined,
        }),
        'telegram',
      );
    });

    it('does not generate URL when session_id is missing', async () => {
      engine = createEngine({ coreAvailable: true });

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalUrl: undefined,
        }),
        'telegram',
      );
    });

    it('uses publicUrl from config when available', async () => {
      const { loadConfig } = await import('../config.js');
      vi.mocked(loadConfig).mockReturnValue({ publicUrl: 'https://my.domain.com', port: 4590 } as any);

      engine = createEngine({ coreAvailable: true, token: 'tk' });

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_session_id: 'sess-002',
      });

      expect(formatNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalUrl: 'https://my.domain.com/terminal.html?id=sess-002&token=tk',
        }),
        'telegram',
      );
    });
  });

  describe('message tracking', () => {
    it('calls trackHookMessage with message ID and session ID', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_session_id: 'sess-track',
      });

      expect(permissions.trackHookMessage).toHaveBeenCalledWith('msg-42', 'sess-track');
    });

    it('passes empty string for session ID when missing', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        message: 'test',
      });

      expect(permissions.trackHookMessage).toHaveBeenCalledWith('msg-42', '');
    });
  });

  describe('receiveIdType', () => {
    it('passes receiveIdType through to outbound message', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        message: 'test',
      }, 'open_id');

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'c1',
          receiveIdType: 'open_id',
        }),
      );
    });

    it('sets receiveIdType to undefined when not provided', async () => {
      engine = createEngine();

      await engine.sendNotification(adapter, 'c1', {
        message: 'test',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          receiveIdType: undefined,
        }),
      );
    });
  });
});
