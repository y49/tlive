import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../src/sdk/codexAdapter.js';
import type { ScannerContextSnapshot } from '../../src/core/scannerContext.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mockCtx: ScannerContextSnapshot = {
  sessionId: 'sess-codex-1',
  workdir: '/home/alice/foo',
  workspaceName: 'foo',
  provider: 'codex',
  terminalUrl: 'http://host/?token=t',
  isLocal: true,
};

function loadJsonl(name: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.startsWith('{') && !line.includes('"_comment"'))
    .map((line) => JSON.parse(line));
}

describe('CodexAdapter.toEvents (golden)', () => {
  const adapter = new CodexAdapter();
  const lines = loadJsonl('codex-session.jsonl');
  const expected = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'codex-expected.json'), 'utf-8'),
  ) as Record<string, unknown[]>;
  const keys = Object.keys(expected);

  for (let i = 0; i < lines.length; i++) {
    const key = keys[i];
    it(`line ${i + 1} — ${key}`, () => {
      expect(adapter.toEvents!(lines[i], mockCtx)).toEqual(expected[key]);
    });
  }
});

describe('CodexAdapter.extractUsage', () => {
  const adapter = new CodexAdapter();

  it('returns usage for event_msg.token_count', () => {
    const out = adapter.extractUsage!({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 30 } },
      },
    });
    expect(out).toEqual({ input_tokens: 100, output_tokens: 50, cached_input_tokens: 30 });
  });

  it('returns null for non-usage events', () => {
    expect(adapter.extractUsage!({ type: 'response_item', payload: {} })).toBeNull();
  });

  it('returns null when payload type is not token_count', () => {
    expect(adapter.extractUsage!({ type: 'event_msg', payload: { type: 'task_complete' } })).toBeNull();
  });

  it('zero-fills missing fields rather than dropping them', () => {
    // Contract: extractUsage always returns all three keys with numeric values when
    // the event is a token_count. Missing fields default to 0.
    const out = adapter.extractUsage!({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 42 } } },
    });
    expect(out).toEqual({ input_tokens: 42, output_tokens: 0, cached_input_tokens: 0 });
  });
});

describe('CodexAdapter.toPermissionEvent', () => {
  it('throws with a clear message (codex scanner path has no broker)', () => {
    const adapter = new CodexAdapter();
    expect(() =>
      adapter.toPermissionEvent!(
        { toolUseId: 'x', toolName: 'x', input: {}, timestamp: 0 },
        mockCtx,
      ),
    ).toThrow(/no permission broker/);
  });
});
