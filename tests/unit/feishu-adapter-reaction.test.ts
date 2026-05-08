import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FeishuAdapter } from '../../src/platform/feishu/adapter.js';

describe('FeishuAdapter.setReaction', () => {
  let adapter: FeishuAdapter;
  let httpPost: ReturnType<typeof vi.fn>;
  let httpDelete: ReturnType<typeof vi.fn>;
  let logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    httpPost = vi.fn().mockResolvedValue({ data: { reaction_id: 'r-1' } });
    httpDelete = vi.fn().mockResolvedValue({ data: {} });
    logger = { warn: vi.fn(), info: vi.fn() };
    adapter = new FeishuAdapter({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      // Inject a stub lark client so the constructor doesn't try to build a real one.
      // bindEventDispatcher suppresses WSClient/EventDispatcher construction.
      client: {},
      bindEventDispatcher: () => { /* no-op: test manages lifecycle */ },
      httpPost,
      httpDelete,
      logger: logger as never,
    });
  });

  it('first setReaction POSTs with mapped emoji_type, caches reaction_id', async () => {
    await adapter.setReaction('msg-1', 'chat-1', '✅');
    expect(httpPost).toHaveBeenCalledWith(
      '/open-apis/im/v1/messages/msg-1/reactions',
      { reaction_type: { emoji_type: 'DONE' } },
    );
    expect(httpDelete).not.toHaveBeenCalled();
  });

  it('second setReaction on same msg DELETEs cached id, POSTs new', async () => {
    await adapter.setReaction('msg-1', 'chat-1', '⏳');
    httpPost.mockClear();
    httpPost.mockResolvedValue({ data: { reaction_id: 'r-2' } });
    await adapter.setReaction('msg-1', 'chat-1', '✅');
    expect(httpDelete).toHaveBeenCalledWith(
      '/open-apis/im/v1/messages/msg-1/reactions/r-1',
    );
    expect(httpPost).toHaveBeenCalledWith(
      '/open-apis/im/v1/messages/msg-1/reactions',
      { reaction_type: { emoji_type: 'DONE' } },
    );
  });

  it('setReaction(null) DELETEs cached id', async () => {
    await adapter.setReaction('msg-1', 'chat-1', '✅');
    await adapter.setReaction('msg-1', 'chat-1', null);
    expect(httpDelete).toHaveBeenCalledWith(
      '/open-apis/im/v1/messages/msg-1/reactions/r-1',
    );
  });

  it('unknown emoji warn-logs and skips API', async () => {
    await adapter.setReaction('msg-1', 'chat-1', '🚀');
    expect(httpPost).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/unmapped reaction emoji/i),
      expect.any(Object),
    );
  });

  it('HTTP 5xx warn-logs and swallows (does not throw)', async () => {
    httpPost.mockRejectedValueOnce(new Error('500 server error'));
    await expect(adapter.setReaction('msg-1', 'chat-1', '✅')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/setReaction failed/i),
      expect.any(Object),
    );
  });

  it('cache is per-messageId — different msg does not share cached id', async () => {
    await adapter.setReaction('msg-1', 'chat-1', '✅');
    httpPost.mockClear();
    await adapter.setReaction('msg-2', 'chat-1', '✅');
    expect(httpDelete).not.toHaveBeenCalled();
    expect(httpPost).toHaveBeenCalledTimes(1);
  });
});
