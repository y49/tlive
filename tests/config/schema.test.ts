// tests/config/schema.test.ts
//
// Covers TliveConfigV1 schema parsing — valid fixtures pass, invalid ones
// surface path-qualified issues.

import { describe, it, expect } from 'vitest';
import { parseConfig, assertConfig } from '../../src/config/schema.js';

describe('parseConfig', () => {
  it('accepts a minimal valid config', () => {
    const res = parseConfig({ version: '1', workspaces: [{ name: 'proj', workdir: '/x' }] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.workspaces).toHaveLength(1);
      expect(res.value.workspaces[0]!.name).toBe('proj');
    }
  });

  it('rejects missing version', () => {
    const res = parseConfig({ workspaces: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === 'version')).toBe(true);
    }
  });

  it('rejects workspace without workdir', () => {
    const res = parseConfig({ version: '1', workspaces: [{ name: 'proj' }] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === 'workspaces[0].workdir')).toBe(true);
    }
  });

  it('rejects invalid provider', () => {
    const res = parseConfig({
      version: '1',
      workspaces: [{ name: 'proj', workdir: '/x', defaults: { provider: 'claude-next' } }],
    });
    expect(res.ok).toBe(false);
  });

  it('accepts all channel blocks', () => {
    const res = parseConfig({
      version: '1',
      workspaces: [{ name: 'p', workdir: '/x' }],
      channels: {
        telegram: { token: 'abc' },
        discord: { token: 'def', applicationId: 'app' },
        feishu: { appId: 'aid', appSecret: 'secret' },
      },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects telegram channel without token', () => {
    const res = parseConfig({
      version: '1',
      workspaces: [{ name: 'p', workdir: '/x' }],
      channels: { telegram: {} },
    });
    expect(res.ok).toBe(false);
  });

  it('records warnings for unknown permission defaults', () => {
    const res = parseConfig({
      version: '1',
      workspaces: [{ name: 'p', workdir: '/x' }],
      permissions: { defaults: { futuristic: 'allow' } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings.some((w) => w.path.includes('futuristic'))).toBe(true);
    }
  });

  it('validates schedule requires one of cron/at/daily/weekly', () => {
    const res = parseConfig({
      version: '1',
      workspaces: [{ name: 'p', workdir: '/x' }],
      schedules: [{ id: 's1', workspaceId: 'w1', prompt: 'hi' }],
    });
    expect(res.ok).toBe(false);
  });

  it('assertConfig throws with readable messages', () => {
    expect(() => assertConfig({ workspaces: [] })).toThrow(/version/);
  });
});

describe('parseConfig adminUserId', () => {
  it('accepts adminUserId as optional string on workspaces[]', () => {
    const r = parseConfig({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w', adminUserId: '12345' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.workspaces[0].adminUserId).toBe('12345');
  });

  it('treats omitted adminUserId as undefined', () => {
    const r = parseConfig({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.workspaces[0].adminUserId).toBeUndefined();
  });

  it('rejects non-string adminUserId', () => {
    const r = parseConfig({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w', adminUserId: 12345 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'workspaces[0].adminUserId')).toBe(true);
  });
});

describe('parseConfig channels.feishu.lark', () => {
  it('accepts lark as boolean', () => {
    const r = parseConfig({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w' }],
      channels: { feishu: { appId: 'cli_x', appSecret: 's', lark: true } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.channels?.feishu?.lark).toBe(true);
  });

  it('treats omitted lark as undefined (defaults to China endpoint downstream)', () => {
    const r = parseConfig({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w' }],
      channels: { feishu: { appId: 'cli_x', appSecret: 's' } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.channels?.feishu?.lark).toBeUndefined();
  });

  it('rejects non-boolean lark', () => {
    const r = parseConfig({
      version: '1',
      workspaces: [{ name: 'w', workdir: '/tmp/w' }],
      channels: { feishu: { appId: 'cli_x', appSecret: 's', lark: 'true' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'channels.feishu.lark')).toBe(true);
  });
});
