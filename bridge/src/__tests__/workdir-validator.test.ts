import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateWorkdir, type ValidationResult } from '../engine/workdir-validator.js';

describe('validateWorkdir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wv-'));

  it('accepts existing directory', () => {
    const result = validateWorkdir(tmp, undefined);
    expect(result.ok).toBe(true);
  });

  it('rejects nonexistent path', () => {
    const result = validateWorkdir(join(tmp, 'nope'), undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it('rejects a file (not a directory)', () => {
    const filePath = join(tmp, 'f.txt');
    writeFileSync(filePath, 'x');
    const result = validateWorkdir(filePath, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/directory/i);
    }
  });

  it('accepts when whitelist is empty/undefined', () => {
    const result = validateWorkdir(tmp, undefined);
    expect(result.ok).toBe(true);
  });

  it('accepts when path is under a whitelisted prefix', () => {
    const result = validateWorkdir(tmp, [tmpdir()]);
    expect(result.ok).toBe(true);
  });

  it('rejects when path is outside whitelist', () => {
    const result = validateWorkdir(tmp, ['/nonexistent-root']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not allowed/i);
    }
  });

  it('resolves path before whitelist check to prevent .. escape', () => {
    const result = validateWorkdir(join(tmp, '..', '..'), [tmp]);
    expect(result.ok).toBe(false);
  });

  it('returns resolved absolute path on success', () => {
    const result = validateWorkdir(tmp, undefined) as Extract<ValidationResult, { ok: true }>;
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(tmp);
  });
});
