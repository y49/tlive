import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateToken } from '../token';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tlive-tok-')); });

describe('loadOrCreateToken', () => {
  it('creates a non-empty token file with 0600 perms', () => {
    const t = loadOrCreateToken(home);
    expect(t.length).toBeGreaterThan(10);
    const p = join(home, 'web-token');
    expect(existsSync(p)).toBe(true);
    // 0600 → mode bits 0o777 == 0o600 (skip strict check on platforms without perms)
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(p, 'utf8').trim()).toBe(t);
  });
  it('returns the same token on second call (idempotent)', () => {
    const a = loadOrCreateToken(home);
    const b = loadOrCreateToken(home);
    expect(b).toBe(a);
  });
});
