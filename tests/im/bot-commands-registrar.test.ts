// tests/im/bot-commands-registrar.test.ts

import { describe, it, expect } from 'vitest';
import { registerAllBotCommands, TOP_COMMANDS } from '../../src/im/bot-commands-registrar.js';
import type { PlatformAdapter } from '../../src/platform/types.js';

function fakeAdapter(channelType: 'telegram' | 'feishu', withHook = true): PlatformAdapter {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = {
    channelType,
    async start() { /* */ },
    async stop() { /* */ },
    async send() { return 'mid'; },
    async edit() { /* */ },
    async delete() { /* */ },
    async pin() { /* */ },
    async setReaction() { /* */ },
    async sendAttachment() { return 'mid'; },
    async downloadAttachment() { return Buffer.from(''); },
    onInbound() { return () => undefined; },
    calls,
    ...(withHook ? {
      async registerBotCommands(list: unknown[]) { calls.push({ method: 'registerBotCommands', args: [list] }); },
    } : {}),
  };
  return adapter as unknown as PlatformAdapter;
}

describe('bot-commands-registrar', () => {
  it('exports 16 top commands', () => {
    expect(TOP_COMMANDS).toHaveLength(16);
    expect(TOP_COMMANDS.map((c) => c.command)).toContain('help');
    expect(TOP_COMMANDS.map((c) => c.command)).toContain('new');
    expect(TOP_COMMANDS.map((c) => c.command)).toContain('sessions');
  });

  it('registers on Telegram adapter via hook', async () => {
    const tg = fakeAdapter('telegram');
    const out = await registerAllBotCommands({ telegram: tg });
    expect(out.telegram).toBe('registered');
    expect(out.feishu).toBe('skipped');
    expect(((tg as unknown as { calls: Array<{ method: string }> }).calls[0]?.method)).toBe('registerBotCommands');
  });

  it('marks Feishu as skipped (no autocomplete)', async () => {
    const fs = fakeAdapter('feishu');
    const out = await registerAllBotCommands({ feishu: fs });
    expect(out.feishu).toBe('skipped');
  });

  it('handles errors from adapter without throwing', async () => {
    const broken = {
      ...fakeAdapter('telegram', false),
      async registerBotCommands() { throw new Error('kaput'); },
    } as unknown as PlatformAdapter;
    const out = await registerAllBotCommands({ telegram: broken });
    expect(out.telegram).toBe('failed');
  });
});
