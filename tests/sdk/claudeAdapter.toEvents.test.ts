import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../src/sdk/claudeAdapter.js';
import type { ScannerContextSnapshot } from '../../src/core/scannerContext.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mockCtx: ScannerContextSnapshot = {
  sessionId: 'sess-1',
  workdir: '/home/alice/foo',
  workspaceName: 'foo',
  provider: 'claude',
  terminalUrl: 'http://host/?token=t',
  isLocal: true,
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf-8'));
}

function loadJsonl(name: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.startsWith('{') && !line.includes('"_comment"'))
    .map((line) => JSON.parse(line));
}

describe('ClaudeAdapter.toEvents (golden)', () => {
  const adapter = new ClaudeAdapter();
  const expected = loadFixture('claude-expected.json') as Record<string, unknown[]>;
  const lines = loadJsonl('claude-session.jsonl');

  for (const line of lines) {
    const uuid = line.uuid as string;
    it(`matches expected output for ${uuid}`, () => {
      const out = adapter.toEvents!(line, mockCtx);
      expect(out).toEqual(expected[uuid]);
    });
  }
});

describe('ClaudeAdapter.toPermissionEvent (golden)', () => {
  const adapter = new ClaudeAdapter();
  const cases = loadFixture('claude-permission-expected.json') as Record<
    string,
    { input: unknown; expected: unknown }
  >;
  for (const [name, { input, expected }] of Object.entries(cases)) {
    it(`matches expected output for ${name}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = adapter.toPermissionEvent!(input as any, mockCtx);
      expect(out).toEqual(expected);
    });
  }
});
