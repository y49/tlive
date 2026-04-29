import { describe, it, expect } from 'vitest';
import { Bot } from 'grammy';
import { TelegramAdapter } from '../../../src/platform/telegram/adapter.js';
import { RateLimitError } from '../../../src/platform/types.js';

/**
 * Build a Bot whose API transformer returns a Telegram-shaped 429 error
 * payload. Grammy converts `{ ok: false, error_code, description, parameters }`
 * into a thrown GrammyError; the adapter must rewrite that into our
 * platform-agnostic RateLimitError.
 */
function mock429Bot(retryAfterSec = 5, description = 'Too Many Requests'): Bot {
  const bot = new Bot('1:test-token');
  bot.api.config.use(async () => ({
    ok: false,
    error_code: 429,
    description,
    parameters: { retry_after: retryAfterSec },
  } as unknown as { ok: false; error_code: number; description: string; parameters: { retry_after: number } }));
  return bot;
}

describe('TelegramAdapter — 429 rate-limit', () => {
  it('send → throws RateLimitError with retry_after * 1000 ms', async () => {
    const bot = mock429Bot(5);
    const adapter = new TelegramAdapter({ token: '1:test-token', bot, skipRunner: true });
    let thrown: unknown;
    try {
      await adapter.send({ chatId: '100', text: 'hi' });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RateLimitError);
    const e = thrown as RateLimitError;
    expect(e.platform).toBe('telegram');
    expect(e.retryAfterMs).toBe(5000);
    expect(e.message).toContain('Too Many Requests');
  });

  it('edit → throws RateLimitError', async () => {
    const bot = mock429Bot(2);
    const adapter = new TelegramAdapter({ token: '1:test-token', bot, skipRunner: true });
    let thrown: unknown;
    try {
      await adapter.edit('1', '100', 'updated text');
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RateLimitError);
    expect((thrown as RateLimitError).retryAfterMs).toBe(2000);
  });

  it('edit → "message is not modified" 仍然 swallow,不被 429 路径拦截', async () => {
    const bot = new Bot('1:test-token');
    bot.api.config.use(async () => ({
      ok: false,
      error_code: 400,
      description: 'Bad Request: message is not modified',
    } as unknown as { ok: false; error_code: number; description: string }));
    const adapter = new TelegramAdapter({ token: '1:test-token', bot, skipRunner: true });
    // Should NOT throw
    await adapter.edit('1', '100', 'unchanged');
  });

  it('missing parameters.retry_after → defaults to 1000ms', async () => {
    const bot = new Bot('1:test-token');
    bot.api.config.use(async () => ({
      ok: false,
      error_code: 429,
      description: 'flood',
    } as unknown as { ok: false; error_code: number; description: string }));
    const adapter = new TelegramAdapter({ token: '1:test-token', bot, skipRunner: true });
    let thrown: unknown;
    try {
      await adapter.send({ chatId: '100', text: 'hi' });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RateLimitError);
    expect((thrown as RateLimitError).retryAfterMs).toBe(1000);
  });
});
