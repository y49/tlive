import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../loader';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-cfg-')); });

describe('loadConfig', () => {
  it('returns defaults on missing file', () => {
    const c = loadConfig(tmp);
    expect(c.allowedSenders).toEqual([]);
    expect(c.adapters).toEqual({});
    expect(c.web).toBeUndefined();
    expect(c.policy).toBeUndefined();
  });
  it('parses an existing config.json', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      allowedSenders: [{ channel: 'telegram', userId: 'u1' }],
      adapters: { telegram: { token: 'T', chatIdAllowList: ['c1'] }, feishu: { appId: 'A', appSecret: 'S', chatId: 'fc1' } },
      web: { port: 7681 },
    }));
    const c = loadConfig(tmp);
    expect(c.adapters.telegram?.token).toBe('T');
    expect(c.adapters.telegram?.chatIdAllowList).toEqual(['c1']);
    expect(c.web?.port).toBe(7681);
  });
});
