import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseSessionScanner, type SessionFileScanResult } from '../../src/core/baseSessionScanner.js';

class FakeScanner extends BaseSessionScanner<{ line: string }> {
  public received: string[] = [];
  constructor(private filePath: string) {
    super({ pollingInterval: 100 });
  }
  protected findSessionFiles() { return [this.filePath]; }
  protected parseSessionFile(filePath: string, cursor: number) {
    const content = require('node:fs').readFileSync(filePath, 'utf-8');
    const bytes = Buffer.byteLength(content);
    const newText = content.slice(cursor);
    const lines = newText.split('\n').filter(Boolean);
    return {
      events: lines.map((line, i) => ({ event: { line }, lineIndex: cursor + i })),
      nextCursor: bytes,
    };
  }
  protected generateEventKey(event: { line: string }, ctx: { filePath: string; lineIndex?: number }) {
    return `${ctx.filePath}:${ctx.lineIndex}`;
  }
  protected onEvent(event: { line: string }) {
    this.received.push(event.line);
  }
}

describe('BaseSessionScanner', () => {
  let scanner: FakeScanner | null = null;
  afterEach(() => { scanner?.stop(); });

  it('emits one event per new line and dedups across scans', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsstest-'));
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'hello\nworld\n');

    scanner = new FakeScanner(filePath);
    await scanner.start();
    await new Promise(r => setTimeout(r, 150));
    expect(scanner.received).toEqual(['hello', 'world']);

    // Re-scan: no new lines
    await scanner.triggerScan();
    expect(scanner.received).toEqual(['hello', 'world']);

    // Append a line
    appendFileSync(filePath, 'again\n');
    await new Promise(r => setTimeout(r, 150));
    expect(scanner.received).toEqual(['hello', 'world', 'again']);
  });

  it('collapses concurrent triggerScan calls into exactly one pending replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsstest-reentrant-'));
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'x\n');

    let release: () => void = () => {};
    let deferred = new Promise<void>(r => (release = r));

    class SlowScanner extends BaseSessionScanner<{ line: string }> {
      public parseCalls = 0;
      constructor(private path: string) {
        super({ pollingInterval: 100_000 });
      }
      protected findSessionFiles() { return [this.path]; }
      protected async parseSessionFile(fp: string, cursor: number): Promise<SessionFileScanResult<{ line: string }>> {
        this.parseCalls++;
        await deferred;
        const content = readFileSync(fp, 'utf-8');
        const bytes = Buffer.byteLength(content);
        const newText = content.slice(cursor);
        const lines = newText.split('\n').filter(Boolean);
        return {
          events: lines.map((line, i) => ({ event: { line }, lineIndex: cursor + i })),
          nextCursor: bytes,
        };
      }
      protected generateEventKey(_e: { line: string }, ctx: { filePath: string; lineIndex?: number }) {
        return `${ctx.filePath}:${ctx.lineIndex}`;
      }
      protected onEvent() { /* noop */ }
    }

    const slow = new SlowScanner(filePath);
    try {
      // Kick off first scan — it will block on `deferred`.
      const first = slow.triggerScan();
      // Two more calls while first is in-flight — both should collapse into ONE pending.
      const second = slow.triggerScan();
      const third = slow.triggerScan();

      // Let pending microtasks flush so the first scan has reached `await deferred`
      // and the second/third calls have returned (short-circuited by scanning flag).
      await Promise.resolve();
      await Promise.resolve();

      // Nothing has progressed past parseSessionFile — parse was called once.
      expect(slow.parseCalls).toBe(1);
      // Second and third should have resolved already (they just set pendingScan).
      await second;
      await third;
      expect(slow.parseCalls).toBe(1);

      // Release the first scan; it will trigger exactly one replay via the finally
      // branch (collapsed from the two pending calls). The replay will also await
      // `deferred`, but `release` was rebound during the first scan's resolution
      // path? No — we keep a single deferred/release pair. So releasing once
      // unblocks BOTH the first scan's parse AND the replay's parse (since we
      // reassign release+deferred below).
      const firstRelease = release;
      // Rebind deferred+release BEFORE resolving the first, so the replay awaits a fresh one.
      deferred = new Promise<void>(r => (release = r));
      firstRelease();

      // Wait a few microtask ticks so the first scan enters finally, kicks off the
      // replay, and the replay reaches its own `await deferred`.
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // The replay scan must have started (2nd parse call) and be blocked.
      expect(slow.parseCalls).toBe(2);

      // Now release the replay.
      release();
      // First awaits the entire chain (original + replay), so awaiting it now completes.
      await first;

      // Final assertion: exactly 2 parse calls — original + one replay, not 3 or 4.
      expect(slow.parseCalls).toBe(2);
    } finally {
      slow.stop();
    }
  });
});
