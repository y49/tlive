import { describe, it, expect } from 'vitest';
import { ChatRouter } from '../chat-router';
import type { IncomingEnvelope } from '../../contracts/im-adapter';

const env = (over: Partial<IncomingEnvelope> = {}): IncomingEnvelope => ({
  channel: 'telegram', chatId: '1', userId: 'u1', messageId: 'm1',
  text: 'hi', ts: 0, ...over,
});

describe('ChatRouter', () => {
  it('routes by chatBindings', () => {
    const r = new ChatRouter({
      bindings: { 'telegram:1': 'ws-a', 'feishu:fc1': 'ws-b' },
      allowedSenders: [{ channel: 'telegram', userId: 'u1' }, { channel: 'feishu', userId: 'u2' }],
    });
    expect(r.route(env({ channel: 'telegram', chatId: '1', userId: 'u1' })))
      .toEqual({ kind: 'route', workspaceId: 'ws-a' });
    expect(r.route(env({ channel: 'feishu', chatId: 'fc1', userId: 'u2' })))
      .toEqual({ kind: 'route', workspaceId: 'ws-b' });
  });

  it('rejects unauthorized sender', () => {
    const r = new ChatRouter({
      bindings: { 'telegram:1': 'ws-a' },
      allowedSenders: [{ channel: 'telegram', userId: 'u1' }],
    });
    const out = r.route(env({ userId: 'evil' }));
    expect(out).toEqual({ kind: 'drop', reason: 'unauthorized-sender' });
  });

  it('returns unbound for unknown chat (authorized sender)', () => {
    const r = new ChatRouter({
      bindings: { 'telegram:1': 'ws-a' },
      allowedSenders: [{ channel: 'telegram', userId: 'u1' }],
    });
    const out = r.route(env({ chatId: '999' }));
    expect(out.kind).toBe('unbound');
  });

  it('updateBinding overrides at runtime (for /use)', () => {
    const r = new ChatRouter({
      bindings: { 'telegram:1': 'ws-a' },
      allowedSenders: [{ channel: 'telegram', userId: 'u1' }],
    });
    r.bind('telegram', '1', 'ws-other');
    expect(r.route(env())).toEqual({ kind: 'route', workspaceId: 'ws-other' });
  });
});
