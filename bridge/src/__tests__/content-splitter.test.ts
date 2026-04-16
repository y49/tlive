import { describe, it, expect } from 'vitest';
import { splitContent } from '../engine/content-splitter.js';

describe('splitContent', () => {
  it('returns single part when under limit', () => {
    const parts = splitContent('short', 100, 'https://example/term');
    expect(parts).toEqual(['short']);
  });

  it('splits long content at line boundaries', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    const parts = splitContent(lines, 200, 'https://example/term');
    expect(parts.length).toBeGreaterThan(1);
    for (let i = 0; i < parts.length; i++) {
      expect(parts[i]).toMatch(new RegExp(`${i + 1}/${parts.length}`));
    }
    expect(parts[0]).toContain('https://example/term');
  });

  it('force-splits at max length when no line boundary available', () => {
    const long = 'x'.repeat(500);
    const parts = splitContent(long, 200, undefined);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(250);  // some slack for part labels
    }
  });

  it('preserves code block fences across splits', () => {
    const content = '```ts\n' + 'line\n'.repeat(100) + '```';
    const parts = splitContent(content, 200, undefined);
    for (const part of parts.slice(0, -1)) {
      expect(part).toContain('```');  // closing fence on non-last pieces
    }
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/^.*(\d+\/\d+).*\n```/);  // opening fence on non-first pieces
    }
  });
});
