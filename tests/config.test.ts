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
    expect(config.port).toBe(8849);
    expect(config.defaultProvider).toBe('claude');
    expect(config.permissionTimeout).toBe(55000);
    expect(config.proactiveNotifyDelay).toBe(60000);
    expect(config.proactiveQuestionDelay).toBe(5000);
  });

  it('reads config.env values', () => {
    writeFileSync(envPath, [
      'TL_PORT=9000',
      'TL_TOKEN=mytoken',
      'TL_DEFAULT_PROVIDER=claude',
      'TL_PERMISSION_TIMEOUT=0',
      'TL_TELEGRAM_TOKEN=tg123',
      'TL_TELEGRAM_CHAT_ID=456',
    ].join('\n'));
    const config = loadConfig(envPath);
    expect(config.port).toBe(9000);
    expect(config.token).toBe('mytoken');
    expect(config.telegram).toEqual({ token: 'tg123', chatId: '456' });
  });

  it('skips comments and blank lines', () => {
    writeFileSync(envPath, '# comment\n\nTL_PORT=7777\n');
    const config = loadConfig(envPath);
    expect(config.port).toBe(7777);
  });

  it('env vars override config file', () => {
    writeFileSync(envPath, 'TL_PORT=9000\n');
    process.env.TL_PORT = '8000';
    const config = loadConfig(envPath);
    expect(config.port).toBe(8000);
    delete process.env.TL_PORT;
  });
});
