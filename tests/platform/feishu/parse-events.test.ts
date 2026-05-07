import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { FeishuAdapter } from '../../../src/platform/feishu/adapter.js';
import type { InboundEvent } from '../../../src/platform/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
}

function newTestAdapter(): { adapter: FeishuAdapter; events: InboundEvent[] } {
  const events: InboundEvent[] = [];
  const adapter = new FeishuAdapter({
    appId: 'cli_x', appSecret: 's',
    client: { fake: true } as never,
    bindEventDispatcher: () => undefined,
  });
  adapter.onInbound((ev) => events.push(ev));
  return { adapter, events };
}

describe('FeishuAdapter inbound parsing (RequestHandle.parse-flattened payloads)', () => {
  it('handleInboundMessage emits InboundEvent from im.message.receive_v1 fixture', () => {
    const { adapter, events } = newTestAdapter();
    adapter.handleInboundMessage(fixture('im-message-receive'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelType: 'feishu',
      chatId: 'oc_chat_1',
      messageId: 'om_msg_1',
      userId: 'ou_sender_1',
      text: 'hello',
      replyToMessageId: 'om_parent_1',
      kind: 'message',
    });
  });

  it('handleCardAction emits callback InboundEvent from card-action-trigger fixture', () => {
    const { adapter, events } = newTestAdapter();
    adapter.handleCardAction(fixture('card-action-trigger'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelType: 'feishu',
      chatId: 'oc_chat_1',
      messageId: 'om_card_1',
      userId: 'ou_op_1',
      callbackData: 'perm:abc:allow',
      kind: 'callback',
    });
  });

  it('handleCardAction reads chat_id from event.context (card 2.0 shape)', () => {
    const { adapter, events } = newTestAdapter();
    adapter.handleCardAction({
      action: { value: { callback_data: 'workspace:create:start' }, tag: 'button' },
      operator: { open_id: 'ou_admin', user_id: 'admin_id' },
      context: { open_chat_id: 'oc_real_chat', open_message_id: 'om_real_msg' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelType: 'feishu',
      chatId: 'oc_real_chat',
      messageId: 'om_real_msg',
      userId: 'ou_admin',
      callbackData: 'workspace:create:start',
      kind: 'callback',
    });
  });

  it('handleCardAction emits form_submit when form_value present', () => {
    const { adapter, events } = newTestAdapter();
    adapter.handleCardAction(fixture('card-form-submit'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelType: 'feishu',
      chatId: 'oc_chat_1',
      userId: 'ou_op_1',
      callbackData: 'form:elic_42:submit',
      formValues: { name: 'Alice', qty: '3' },
      kind: 'form_submit',
    });
  });

  it('handleInboundMessage drops unrecognized payload (no message field) silently', () => {
    const { adapter, events } = newTestAdapter();
    adapter.handleInboundMessage({ random: 'garbage' });
    expect(events).toHaveLength(0);
  });
});
