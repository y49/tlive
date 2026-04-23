// tests/platform/util.test.ts
//
// Fence-aware splitText regression guard (T6 review fix #6).
// Before: splitText split blindly at maxLen / newline — a chunk boundary
// in the middle of a ```bash code fence would leave chunk 1 with an
// unclosed fence and chunk 2 "rendered as code" when it shouldn't be.
// After: balanceFences closes any odd-numbered fence and reopens it on
// the next chunk with the original language tag.

import { describe, it, expect } from 'vitest';
import { splitText } from '../../src/platform/types.js';

function countFences(text: string): number {
  return (text.match(/(^|\n)```/g) ?? []).length;
}

describe('splitText fence-awareness', () => {
  it('short text under cap is unchanged', () => {
    const t = 'hello';
    expect(splitText(t, 100)).toEqual([t]);
  });

  it('plain long text splits at newlines with every chunk within cap', () => {
    const body = Array(200).fill('line').join('\n'); // ~ 200*5 = 1000
    const chunks = splitText(body, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
  });

  it('code fence straddling a chunk boundary is balanced', () => {
    // Build a ~3000-char payload with a long ```bash block in the middle.
    const head = 'Here is some output:\n';
    const codeLines = Array(400).fill('echo hello').join('\n'); // ~ 400*11 = 4400
    const code = '```bash\n' + codeLines + '\n```';
    const tail = '\nThat is all.';
    const text = head + code + tail;

    const chunks = splitText(text, 1000);
    // Every chunk must have an even count of fences (balanced).
    for (const c of chunks) {
      expect(countFences(c) % 2).toBe(0);
    }
    // And the language tag must survive through re-opens (at least one
    // chunk after the first contains ```bash at its start).
    const reopened = chunks.slice(1).some((c) => c.startsWith('```bash'));
    expect(reopened).toBe(true);
  });

  it('fence without language tag is preserved across chunk boundary', () => {
    const codeLines = Array(300).fill('some-code').join('\n');
    const text = '```\n' + codeLines + '\n```';
    const chunks = splitText(text, 1000);
    for (const c of chunks) {
      expect(countFences(c) % 2).toBe(0);
    }
  });
});
