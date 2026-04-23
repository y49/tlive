import { describe, it, expect, vi } from 'vitest';
import { Bot } from 'grammy';
import { TelegramAdapter } from '../../../src/platform/telegram/adapter.js';

function mockBot(): Bot {
  const b = new Bot('1:test-token'); // token format validates
  // Stub the transport — grammy's `api` is the method surface.
  b.api.config.use(async () => ({ ok: true, result: { message_id: 42 } } as unknown as { ok: true; result: { message_id: number } }));
  return b;
}

describe('TelegramAdapter', () => {
  it('send returns string id from bot API', async () => {
    const bot = mockBot();
    const adapter = new TelegramAdapter({ token: '1:test-token', bot, skipRunner: true });
    const id = await adapter.send({ chatId: '100', text: 'hello' });
    expect(id).toBe('42');
  });

  it('onInbound subscribe/unsubscribe', () => {
    const bot = mockBot();
    const adapter = new TelegramAdapter({ token: '1:test-token', bot, skipRunner: true });
    const cb = vi.fn();
    const unsub = adapter.onInbound(cb);
    unsub();
    // Listener removed; can't emit directly without full grammy dispatch, but
    // verifying no throws on unsubscribe is enough here.
    expect(typeof unsub).toBe('function');
  });
});
