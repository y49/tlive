import { describe, it, expect } from 'vitest';
import type { IncomingEnvelope, OutgoingMessage } from '../../src/kernel/contracts/im-adapter';

describe('IncomingEnvelope contract', () => {
  it('has exactly 7 fields (6 required + 1 optional)', () => {
    const e: IncomingEnvelope = {
      channel: 'telegram',
      chatId: '1',
      userId: '2',
      messageId: '3',
      text: 'hi',
      ts: 1700000000000,
    };
    const keys = Object.keys(e).sort();
    expect(keys).toEqual(['channel', 'chatId', 'messageId', 'text', 'ts', 'userId']);
  });

  it('replyToMessageId is optional', () => {
    const e: IncomingEnvelope = {
      channel: 'feishu', chatId: '1', userId: '2', messageId: '3',
      text: 'hi', ts: 0, replyToMessageId: '0',
    };
    expect(e.replyToMessageId).toBeDefined();
  });
});

describe('OutgoingMessage contract', () => {
  it('text variant', () => {
    const m: OutgoingMessage = { kind: 'text', text: 'hi' };
    expect(m.kind).toBe('text');
  });

  it('card variant with buttons', () => {
    const m: OutgoingMessage = {
      kind: 'card', title: 'Q', body: 'allow?',
      buttons: [{ id: 'yes', label: '✅' }, { id: 'no', label: '❌' }],
    };
    expect(m.buttons).toHaveLength(2);
  });
});
