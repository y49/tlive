import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { FeishuAdapter, stripLeadingMentions } from '../feishu.js';

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

    // allowedSenders is documented as open IDs (ou_…). Feishu always sends
    // open_id; user_id is only filled when the app holds an extra contact
    // permission the setup docs never ask for — reading it left userId empty
    // and the allowlist silently dropped every text message.
    it('reports the sender by open_id, which Feishu always sends', async () => {
      const msg = makeMsg('chat-ok');
      msg.sender.sender_id = { open_id: 'ou_me' } as never;
      await capturedHandlers['im.message.receive_v1'](msg);
      expect(inbound.mock.calls[0][0]).toMatchObject({ userId: 'ou_me' });
    });

    it('prefers open_id over user_id when both are present', async () => {
      const msg = makeMsg('chat-ok');
      msg.sender.sender_id = { open_id: 'ou_me', user_id: 'u1' } as never;
      await capturedHandlers['im.message.receive_v1'](msg);
      expect(inbound.mock.calls[0][0]).toMatchObject({ userId: 'ou_me' });
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

  // --- group @mention prefix ---
  // Feishu puts a PLACEHOLDER in the text, not a name: a group message that
  // @s the bot arrives as "@_user_1 /help" (im.message.receive_v1 wire sample).
  // Unstripped, every group command misses `text.startsWith('/')` and falls
  // into the bare-text branch — the DM works, the group silently doesn't.
  describe('im.message.receive_v1 @mention prefix', () => {
    let inbound: ReturnType<typeof vi.fn>;
    let adapter: FeishuAdapter;

    beforeEach(async () => {
      adapter = new FeishuAdapter({ appId: 'A', appSecret: 'S', chatId: 'oc_group' });
      await adapter.start();
      inbound = vi.fn();
      adapter.onInbound(inbound);
    });

    afterEach(async () => { await adapter.stop(); });

    const groupMsg = (text: string) => ({
      sender: { sender_id: { user_id: 'u1' } },
      message: {
        message_id: 'mid1',
        chat_id: 'oc_group',
        content: JSON.stringify({ text }),
        create_time: '1700000000000',
      },
      mentions: [{ key: '@_user_1', name: 'tlive', id: { open_id: 'ou_bot' } }],
    });

    const textOf = (): string => (inbound.mock.calls[0][0] as { text: string }).text;

    it('drops the leading mention so a group command arrives as typed', async () => {
      await capturedHandlers['im.message.receive_v1'](groupMsg('@_user_1 /help'));
      expect(textOf()).toBe('/help');
    });

    it('drops several leading mentions and the whitespace between them', async () => {
      await capturedHandlers['im.message.receive_v1'](groupMsg('@_user_1  @_user_2   你好'));
      expect(textOf()).toBe('你好');
    });

    it('keeps a mention that is part of the sentence', async () => {
      await capturedHandlers['im.message.receive_v1'](groupMsg('@_user_1 让 @_user_2 也看看'));
      expect(textOf()).toBe('让 @_user_2 也看看');
    });

    it('leaves a p2p message with no mention untouched', async () => {
      await capturedHandlers['im.message.receive_v1'](groupMsg('hello'));
      expect(textOf()).toBe('hello');
    });

    it('turns a bare mention into empty text instead of injecting the token', async () => {
      await capturedHandlers['im.message.receive_v1'](groupMsg('@_user_1'));
      expect(textOf()).toBe('');
    });
  });

  describe('stripLeadingMentions', () => {
    it('handles @_all and only at the start', () => {
      expect(stripLeadingMentions('@_all 大家好')).toBe('大家好');
      expect(stripLeadingMentions('大家好 @_all')).toBe('大家好 @_all');
    });

    it('does not eat text that merely looks similar', () => {
      expect(stripLeadingMentions('@_user_1x is not a mention')).toBe('@_user_1x is not a mention');
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

    // Same id as a text message from the same person — otherwise one
    // allowedSenders entry passes buttons but not text, or the reverse.
    it('prefers open_id over user_id, matching text messages', async () => {
      const cb = makeCallback('chat-ok', 'approve:abc');
      cb.operator = { open_id: 'ou_me', user_id: 'u1' } as never;
      await capturedHandlers['card.action.trigger'](cb);
      expect(inbound.mock.calls[0][0]).toMatchObject({ userId: 'ou_me' });
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
