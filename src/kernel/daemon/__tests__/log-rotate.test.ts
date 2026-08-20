import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateIfOversized } from '../log-rotate.js';

// Real incident, 2026-08-14: a reconnect loop whose backoff timer doubled per
// failure wrote 221,547 identical lines in ONE hour. The bug is fixed; what is
// not is that daemon.log has no ceiling at all, so those 115MB sit on disk
// forever and the next flood costs the same again. The inbox has had an age +
// total-size cap since it was written; the log is the surface that never got one.
describe('rotateIfOversized', () => {
  let dir: string;
  const line = (n: number) => `{"ts":"2026-08-19T00:00:00.000Z","level":"info","msg":"line ${n}"}\n`;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tlive-rot-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('leaves a log under the cap completely alone', () => {
    const p = join(dir, 'daemon.log');
    const body = line(1) + line(2);
    writeFileSync(p, body);
    expect(rotateIfOversized(p, { capBytes: 1024, keepBytes: 256 })).toBeNull();
    expect(readFileSync(p, 'utf8')).toBe(body);
  });

  it('keeps the NEWEST lines and drops the rest — the tail is the part worth reading', () => {
    const p = join(dir, 'daemon.log');
    writeFileSync(p, Array.from({ length: 2000 }, (_, i) => line(i)).join(''));
    const before = statSync(p).size;
    const dropped = rotateIfOversized(p, { capBytes: 4096, keepBytes: 1024 });
    expect(dropped).toBeGreaterThan(0);
    const after = readFileSync(p, 'utf8');
    expect(statSync(p).size).toBeLessThan(before);
    expect(after).toContain('"msg":"line 1999"');   // newest survived
    expect(after).not.toContain('"msg":"line 0"');  // oldest gone
  });

  it('never leaves a half line at the top — every line in the file stays parseable', () => {
    const p = join(dir, 'daemon.log');
    writeFileSync(p, Array.from({ length: 2000 }, (_, i) => line(i)).join(''));
    rotateIfOversized(p, { capBytes: 4096, keepBytes: 1024 });
    for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  // Silent truncation would make the log lie by omission: a gap you cannot see
  // reads as "nothing happened then".
  it('records what it dropped, in the same JSON shape as the rest of the log', () => {
    const p = join(dir, 'daemon.log');
    writeFileSync(p, Array.from({ length: 2000 }, (_, i) => line(i)).join(''));
    const dropped = rotateIfOversized(p, { capBytes: 4096, keepBytes: 1024 })!;
    const first = JSON.parse(readFileSync(p, 'utf8').split('\n')[0]!);
    expect(first.msg).toBe('log.truncated');
    expect(first.droppedBytes).toBe(dropped);
    expect(first.level).toBe('warn');
  });

  it('a missing log is not an error — the daemon may not have written one yet', () => {
    expect(rotateIfOversized(join(dir, 'nope.log'), { capBytes: 10, keepBytes: 5 })).toBeNull();
  });
});
