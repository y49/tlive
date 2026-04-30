import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const testDir = join(tmpdir(), 'tlive-config-test-' + Date.now());
  const envPath = join(testDir, 'config.env');

  beforeEach(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('returns defaults when no config file exists', () => {
    const config = loadConfig(join(testDir, 'nonexistent.env'));
    expect(config.token).toBe('');
    expect(config.runtime).toBe('claude');
    expect(config.telegram).toBeUndefined();
    expect(config.feishu).toBeUndefined();
  });

  it('reads config.env values', () => {
    writeFileSync(envPath, [
      'TL_TOKEN=mytoken',
      'TL_RUNTIME=codex',
      'TL_TG_BOT_TOKEN=tg123',
      'TL_TG_CHAT_ID=456',
    ].join('\n'));
    const config = loadConfig(envPath);
    expect(config.token).toBe('mytoken');
    expect(config.runtime).toBe('codex');
    expect(config.telegram).toEqual({ token: 'tg123', chatId: '456' });
  });

  it('skips comments and blank lines', () => {
    writeFileSync(envPath, '# comment\n\nTL_TOKEN=secret\n');
    const config = loadConfig(envPath);
    expect(config.token).toBe('secret');
  });

  it('env vars override config file', () => {
    writeFileSync(envPath, 'TL_TOKEN=from-file\n');
    process.env.TL_TOKEN = 'from-env';
    const config = loadConfig(envPath);
    expect(config.token).toBe('from-env');
    delete process.env.TL_TOKEN;
  });

  it('falls back to claude when TL_RUNTIME is unknown', () => {
    writeFileSync(envPath, 'TL_RUNTIME=gpt\n');
    const config = loadConfig(envPath);
    expect(config.runtime).toBe('claude');
  });
});
