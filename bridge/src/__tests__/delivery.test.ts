import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../delivery/delivery.js';

describe('fence-aware chunking', () => {
  it('preserves code block fences across chunks', () => {
    const text = '# Title\n```js\n' + 'let x = 1;\n'.repeat(100) + '```\nEnd.';
    const chunks = chunkMarkdown(text, 200);
    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it('reopens code block in next chunk', () => {
    const text = '```\n' + 'line\n'.repeat(50) + '```';
    const chunks = chunkMarkdown(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].trimEnd().endsWith('```')).toBe(true);
    expect(chunks[1].startsWith('```')).toBe(true);
  });

  it('handles text without code blocks normally', () => {
    const text = 'Hello\nWorld\nFoo\nBar';
    const chunks = chunkMarkdown(text, 12);
    expect(chunks.join('\n')).toContain('Hello');
    expect(chunks.join('\n')).toContain('Bar');
  });

  it('returns single chunk if within limit', () => {
    expect(chunkMarkdown('short text', 100)).toEqual(['short text']);
  });

  it('splits long line without code block', () => {
    const chunks = chunkMarkdown('A'.repeat(300), 100);
    expect(chunks.length).toBe(3);
  });
});
