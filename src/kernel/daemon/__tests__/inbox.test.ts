import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepInbox } from '../inbox.js';

function seed(dir: string, name: string, bytes: number, ageMs: number, now: number): void {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes));
  const t = (now - ageMs) / 1000;
  utimesSync(p, t, t);
}

describe('sweepInbox', () => {
  it('deletes expired files and keeps fresh ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-ibx-'));
    const now = Date.now();
    seed(dir, 'old.png', 10, 3 * 24 * 3600_000, now);   // 3 days old
    seed(dir, 'fresh.png', 10, 3600_000, now);          // 1h old
    const n = sweepInbox(dir, { maxAgeMs: 48 * 3600_000, maxTotalBytes: 1e9 }, now);
    expect(n).toBe(1);
    expect(readdirSync(dir)).toEqual(['fresh.png']);
  });

  it('trims oldest-first down to the size cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-ibx-'));
    const now = Date.now();
    seed(dir, 'a-oldest', 100, 3600_000, now);
    seed(dir, 'b-mid', 100, 1800_000, now);
    seed(dir, 'c-new', 100, 60_000, now);
    const n = sweepInbox(dir, { maxAgeMs: 1e12, maxTotalBytes: 250 }, now);
    expect(n).toBe(1); // drop the oldest → 200 ≤ 250
    const left = readdirSync(dir).sort();
    expect(left).toEqual(['b-mid', 'c-new']);
  });

  it('returns 0 for a missing directory', () => {
    expect(sweepInbox(join(tmpdir(), 'nope-ibx'))).toBe(0);
  });
});
