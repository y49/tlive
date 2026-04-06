import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig } from '../config.js';

// Prevent loadConfig from reading ~/.tlive/config.env so tests use pure defaults
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string, ...args: any[]) => {
      if (typeof path === 'string' && path.includes('config.env')) {
        throw new Error('ENOENT');
      }
      return actual.readFileSync(path, ...args);
    }),
  };
});

describe('loadConfig', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.TL_TOKEN = 'test-token';
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TL_')) delete process.env[key];
    }
  });

  it('uses defaults when no env vars set', () => {
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.runtime).toBe('claude');
    expect(config.coreUrl).toBe('http://localhost:8080');
  });

  it('loads from env vars', () => {
    process.env.TL_PORT = '9090';
    process.env.TL_TOKEN = 'test-token';
    process.env.TL_PUBLIC_URL = 'https://example.com';
    const config = loadConfig();
    expect(config.port).toBe(9090);
    expect(config.token).toBe('test-token');
    expect(config.publicUrl).toBe('https://example.com');
    expect(config.coreUrl).toBe('http://localhost:9090');
  });

  it('parses enabled channels', () => {
    process.env.TL_ENABLED_CHANNELS = 'telegram,discord';
    process.env.TL_TG_BOT_TOKEN = 'tg-token';
    process.env.TL_DC_BOT_TOKEN = 'dc-token';
    const config = loadConfig();
    expect(config.enabledChannels).toEqual(['telegram', 'discord']);
  });

  it('parses telegram config', () => {
    process.env.TL_TG_BOT_TOKEN = 'tg-token';
    process.env.TL_TG_CHAT_ID = '12345';
    process.env.TL_TG_ALLOWED_USERS = 'user1,user2';
    const config = loadConfig();
    expect(config.telegram.botToken).toBe('tg-token');
    expect(config.telegram.chatId).toBe('12345');
    expect(config.telegram.allowedUsers).toEqual(['user1', 'user2']);
  });

  it('parses discord config', () => {
    process.env.TL_DC_BOT_TOKEN = 'dc-token';
    process.env.TL_DC_ALLOWED_USERS = 'u1,u2';
    process.env.TL_DC_ALLOWED_CHANNELS = 'ch1';
    const config = loadConfig();
    expect(config.discord.botToken).toBe('dc-token');
    expect(config.discord.allowedUsers).toEqual(['u1', 'u2']);
    expect(config.discord.allowedChannels).toEqual(['ch1']);
  });

  it('parses feishu config', () => {
    process.env.TL_FS_APP_ID = 'fs-id';
    process.env.TL_FS_APP_SECRET = 'fs-secret';
    process.env.TL_FS_ALLOWED_USERS = 'fsu1';
    const config = loadConfig();
    expect(config.feishu.appId).toBe('fs-id');
    expect(config.feishu.appSecret).toBe('fs-secret');
    expect(config.feishu.allowedUsers).toEqual(['fsu1']);
  });

  it('overrides core URL with TL_CORE_URL', () => {
    process.env.TL_CORE_URL = 'http://core:9999';
    const config = loadConfig();
    expect(config.coreUrl).toBe('http://core:9999');
  });
});
