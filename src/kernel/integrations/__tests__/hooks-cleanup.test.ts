import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('codexPluginHooksPath', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const home = (): string => { const d = mkdtempSync(join(tmpdir(), 'tlive-cphp-')); dirs.push(d); return d; };

  it('扫描版本目录解析实际路径(2.0.0 布局,E2E 实测)', async () => {
    const { codexPluginHooksPath } = await import('../hooks-cleanup');
    const h = home();
    const hooksDir = join(h, 'plugins', 'cache', 'tlive', 'tlive', '2.0.0', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'hooks.json'), '{}');
    expect(codexPluginHooksPath(h)).toBe(join(hooksDir, 'hooks.json'));
  });
  it('cache 不存在 → null', async () => {
    const { codexPluginHooksPath } = await import('../hooks-cleanup');
    expect(codexPluginHooksPath(home())).toBeNull();
  });
});

describe('commandOnPath', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('finds an executable placed on PATH, misses a bogus name', async () => {
    const { commandOnPath } = await import('../hooks-cleanup');
    const dir = mkdtempSync(join(tmpdir(), 'tlive-path-'));
    dirs.push(dir);
    const exe = join(dir, 'tlivefakebin');
    writeFileSync(exe, '#!/bin/sh\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(exe, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = dir + (process.platform === 'win32' ? ';' : ':') + (prevPath ?? '');
    try {
      expect(commandOnPath('tlivefakebin')).toBe(true);
      expect(commandOnPath('tlive-definitely-not-a-real-binary-xyz')).toBe(false);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
