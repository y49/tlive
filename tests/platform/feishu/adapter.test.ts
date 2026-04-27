import { describe, it, expect, vi } from 'vitest';
import { FeishuAdapter } from '../../../src/platform/feishu/adapter.js';

function mkLarkClient() {
  return {
    im: {
      v1: {
        message: {
          create: vi.fn().mockResolvedValue({ data: { message_id: 'm-42' } }),
          patch: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
        },
        pin: { create: vi.fn().mockResolvedValue({}) },
      },
    },
  };
}

describe('FeishuAdapter', () => {
  it('send returns the assigned message_id', async () => {
    const client = mkLarkClient();
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 's', client });
    const id = await adapter.send({ chatId: 'c1', text: 'hi' });
    expect(id).toBe('m-42');
    expect(client.im.v1.message.create).toHaveBeenCalledTimes(1);
    const payload = client.im.v1.message.create.mock.calls[0]![0] as { data: { msg_type: string } };
    expect(payload.data.msg_type).toBe('interactive');
  });

  it('setReaction throws (unsupported)', async () => {
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 's', client: mkLarkClient() });
    await expect(adapter.setReaction('m', 'c', '👍')).rejects.toThrow();
  });

  it('parses inbound message events', () => {
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 's', client: mkLarkClient() });
    const received: unknown[] = [];
    adapter.onInbound((ev) => received.push(ev));
    // SDK's RequestHandle.parse() flattens v2 events: `{ ...rest, ...header, ...event }`.
    // So `message` and `sender` arrive at the TOP level, not under `.event`.
    adapter.handleInboundMessage({
      message: { message_id: 'mm', chat_id: 'cc', content: JSON.stringify({ text: 'hi' }) },
      sender: { sender_id: { open_id: 'u1' } },
    });
    expect(received).toHaveLength(1);
    expect((received[0] as { text: string }).text).toBe('hi');
  });

  it('parses card action events', () => {
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 's', client: mkLarkClient() });
    const received: unknown[] = [];
    adapter.onInbound((ev) => received.push(ev));
    adapter.handleCardAction({
      action: { value: { callback_data: 'perm:allow:1' } },
      operator: { open_id: 'u1' },
      open_message_id: 'mm',
      open_chat_id: 'cc',
    });
    expect(received).toHaveLength(1);
    expect((received[0] as { callbackData: string; kind: string }).callbackData).toBe('perm:allow:1');
    expect((received[0] as { kind: string }).kind).toBe('callback');
  });
});
