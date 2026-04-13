import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CodexSessionScanner,
  type CodexEvent,
} from '../../src/core/codexSessionScanner.js';

describe('CodexSessionScanner', () => {
  let scanner: CodexSessionScanner | null = null;

  afterEach(() => {
    scanner?.stop();
    scanner = null;
  });

  it('emits events for each jsonl line in nested date dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    const dayDir = join(root, '2026', '04', '13');
    mkdirSync(dayDir, { recursive: true });
    const file = join(dayDir, 'rollout-abc.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ type: 'message', id: 'e1' }) +
        '\n' +
        JSON.stringify({ type: 'tool_use', id: 'e2' }) +
        '\n',
    );

    scanner = new CodexSessionScanner({
      sessionDir: root,
      startupTimestampMs: 0,
      pollingInterval: 50,
    });
    const received: CodexEvent[] = [];
    scanner.on('event', (e: CodexEvent) => received.push(e));
    await scanner.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(received.map((e) => e.type)).toEqual(['message', 'tool_use']);
  });

  it('dedupes events across scans by uuid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    const dayDir = join(root, '2026', '04', '13');
    mkdirSync(dayDir, { recursive: true });
    const file = join(dayDir, 'rollout-xyz.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ type: 'message', id: 'dup-1' }) + '\n',
    );

    scanner = new CodexSessionScanner({
      sessionDir: root,
      startupTimestampMs: 0,
      pollingInterval: 50,
    });
    const received: CodexEvent[] = [];
    scanner.on('event', (e: CodexEvent) => received.push(e));
    await scanner.start();
    await new Promise((r) => setTimeout(r, 150));
    // Append the SAME id again with a slightly different payload — base scanner should dedupe by uuid key.
    writeFileSync(
      file,
      JSON.stringify({ type: 'message', id: 'dup-1' }) +
        '\n' +
        JSON.stringify({ type: 'message', id: 'new-2' }) +
        '\n',
    );
    await new Promise((r) => setTimeout(r, 200));
    const ids = received.map((e) => e.uuid);
    expect(ids.filter((i) => i === 'dup-1')).toHaveLength(1);
    expect(ids).toContain('new-2');
  });
});
