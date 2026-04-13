import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseSessionScanner } from '../../src/core/baseSessionScanner.js';

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
});
