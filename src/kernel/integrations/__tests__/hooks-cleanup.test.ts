import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
