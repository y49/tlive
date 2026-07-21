import { describe, it, expect, vi, beforeEach } from 'vitest';

// capturedHandlers is populated by the EventDispatcher mock's register() call.
const capturedHandlers: Record<string, (data: unknown) => Promise<unknown>> = {};
const close = vi.fn();

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { im = { v1: { message: { create: vi.fn(async () => ({ data: { message_id: 'fmid-1' } })), patch: vi.fn() } } }; },
  WSClient: class {
    start = vi.fn(); close = close;
  },
  EventDispatcher: class {
    register(h: Record<string, (data: unknown) => Promise<unknown>>) {
      Object.assign(capturedHandlers, h);
    }
  },
}));

import { FeishuAdapter } from '../feishu.js';

describe('FeishuAdapter', () => {
  beforeEach(() => {
    // Clear captured handlers before each test so tests don't bleed into each other.
    for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
    close.mockClear();
  });

  it('start + stop', async () => {
    const a = new FeishuAdapter({ appId: 'A', appSecret: 'S' });
    await a.start();
    expect(a.isConnected()).toBe('connected');
    await a.stop();
    expect(a.isConnected()).toBe('idle');
    expect(close).toHaveBeenCalled();
  });

  it('stop is idempotent', async () => {
    const a = new FeishuAdapter({ appId: 'A', appSecret: 'S' });
    await a.start();
    await a.stop(); await a.stop();
    expect(a.isConnected()).toBe('idle');
  });

  // --- inbound chat filter (fail-closed) ---

  describe('im.message.receive_v1 filter', () => {
    let inbound: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const a = new FeishuAdapter({ appId: 'A', appSecret: 'S', chatId: 'chat-ok' });
      await a.start();
      inbound = vi.fn();
      a.onInbound(inbound);
    });

    // REAL producer shape: the SDK's EventDispatcher.parse flattens the v2
    // payload to {...header, ...event} before invoking handlers — message and
    // sender live at the TOP level. The old wrapped {event:{…}} fixtures
    // encoded the bug that crashed every live inbound (test corpus must match
    // the real producer — same lesson as Plan 14's excerpt fixtures).
    const makeMsg = (chatId: string) => ({
      sender: { sender_id: { user_id: 'u1' } },
      message: {
        message_id: 'mid1',
        chat_id: chatId,
        content: '{"text":"hello"}',
        create_time: '1700000000000',
      },
    });

    it('forwards message from configured chat', async () => {
      await capturedHandlers['im.message.receive_v1'](makeMsg('chat-ok'));
      expect(inbound).toHaveBeenCalledOnce();
      expect(inbound.mock.calls[0][0]).toMatchObject({ chatId: 'chat-ok', text: 'hello' });
    });

    it('carries parent_id through as replyToMessageId (quote-reply routing)', async () => {
      const msg = makeMsg('chat-ok');
      (msg.message as Record<string, unknown>).parent_id = 'om_parent';
      await capturedHandlers['im.message.receive_v1'](msg);
      expect(inbound.mock.calls[0][0]).toMatchObject({ replyToMessageId: 'om_parent' });
    });

    it('still tolerates the legacy wrapped {event:{…}} shape', async () => {
      await capturedHandlers['im.message.receive_v1']({ event: makeMsg('chat-ok') });
      expect(inbound).toHaveBeenCalledOnce();
      expect(inbound.mock.calls[0][0]).toMatchObject({ chatId: 'chat-ok', text: 'hello' });
    });

    it('drops message from non-configured chat', async () => {
      await capturedHandlers['im.message.receive_v1'](makeMsg('chat-other'));
      expect(inbound).not.toHaveBeenCalled();
    });

    it('drops message when no chatId configured (fail-closed)', async () => {
      // New adapter with no chatId
      const a2 = new FeishuAdapter({ appId: 'A', appSecret: 'S' });
      // Clear captured handlers and restart to get this adapter's handlers
      for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
      await a2.start();
      const inbound2 = vi.fn();
      a2.onInbound(inbound2);
      await capturedHandlers['im.message.receive_v1'](makeMsg('chat-ok'));
      expect(inbound2).not.toHaveBeenCalled();
      await a2.stop();
    });
  });

  describe('card.action.trigger filter', () => {
    let inbound: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const a = new FeishuAdapter({ appId: 'A', appSecret: 'S', chatId: 'chat-ok' });
      await a.start();
      inbound = vi.fn();
      a.onInbound(inbound);
    });

    // Flattened, same as above — operator/action/context at the top level.
    const makeCallback = (chatId: string, buttonId: string) => ({
      operator: { user_id: 'u1' },
      action: { value: { tlive: buttonId } },
      context: { open_chat_id: chatId, open_message_id: 'mid1' },
    });

    it('forwards callback from configured chat', async () => {
      await capturedHandlers['card.action.trigger'](makeCallback('chat-ok', 'approve:abc'));
      expect(inbound).toHaveBeenCalledOnce();
      expect(inbound.mock.calls[0][0]).toMatchObject({ chatId: 'chat-ok', text: 'approve:abc' });
    });

    it('still tolerates the legacy wrapped {event:{…}} shape', async () => {
      await capturedHandlers['card.action.trigger']({ event: makeCallback('chat-ok', 'approve:abc') });
      expect(inbound).toHaveBeenCalledOnce();
      expect(inbound.mock.calls[0][0]).toMatchObject({ text: 'approve:abc' });
    });

    it('drops callback from non-configured chat', async () => {
      await capturedHandlers['card.action.trigger'](makeCallback('chat-wrong', 'approve:abc'));
      expect(inbound).not.toHaveBeenCalled();
    });

    it('drops callback when no chatId configured (fail-closed)', async () => {
      const a2 = new FeishuAdapter({ appId: 'A', appSecret: 'S' });
      for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
      await a2.start();
      const inbound2 = vi.fn();
      a2.onInbound(inbound2);
      await capturedHandlers['card.action.trigger'](makeCallback('chat-ok', 'deny:abc'));
      expect(inbound2).not.toHaveBeenCalled();
      await a2.stop();
    });
  });
});
