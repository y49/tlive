import { describe, it, expect, vi } from 'vitest';

vi.mock('grammy', () => ({
  Bot: class { start = vi.fn(); stop = vi.fn(); on = vi.fn(); api = {}; },
}));

import { TelegramAdapter } from '../telegram';

describe('TelegramAdapter', () => {
  it('start + stop without throwing', async () => {
    const a = new TelegramAdapter({ token: 'T' });
    await a.start();
    expect(a.isConnected()).toBe('connected');
    await a.stop();
    expect(a.isConnected()).toBe('idle');
  });

  it('stop is idempotent', async () => {
    const a = new TelegramAdapter({ token: 'T' });
    await a.start();
    await a.stop(); await a.stop();
    expect(a.isConnected()).toBe('idle');
  });

  it('exposes handles count via test hook (must be 0 after stop)', async () => {
    const a = new TelegramAdapter({ token: 'T' });
    await a.start();
    await a.stop();
    expect((a as any).activeTimers).toBe(0);
  });
});
