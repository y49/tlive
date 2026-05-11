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
    expect(c.workspaces).toEqual({});
    expect(c.chatBindings).toEqual({});
    expect(c.allowedSenders).toEqual([]);
    expect(c.adapters).toEqual({});
  });

  it('parses an existing config.json', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      workspaces: { 'ws-a': '/a' },
      chatBindings: { 'telegram:1': 'ws-a' },
      allowedSenders: [{ channel: 'telegram', userId: 'u1' }],
      adapters: { telegram: { token: 'T' }, feishu: { appId: 'A', appSecret: 'S' } },
    }));
    const c = loadConfig(tmp);
    expect(c.workspaces['ws-a']).toBe('/a');
    expect(c.adapters.telegram?.token).toBe('T');
  });
});
