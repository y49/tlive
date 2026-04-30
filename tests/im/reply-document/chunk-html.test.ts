import { describe, it, expect } from 'vitest';
import { chunkHtmlForTelegram } from '../../../src/im/reply-document/markdown.js';

describe('chunkHtmlForTelegram', () => {
  it('returns single chunk when under limit', () => {
    const input = 'hello world';
    expect(chunkHtmlForTelegram(input, 100)).toEqual(['hello world']);
  });

  it('splits at paragraph boundary (\\n\\n) preferentially', () => {
    const input = 'paragraph one\n\nparagraph two\n\nparagraph three';
    const chunks = chunkHtmlForTelegram(input, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20);
    expect(chunks.join('\n\n')).toBe(input);
  });

  it('falls back to line boundary (\\n) when no paragraph split available', () => {
    const input = 'line one\nline two\nline three\nline four';
    const chunks = chunkHtmlForTelegram(input, 18);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(18);
  });

  it('falls back to hard cut when no boundary fits', () => {
    const input = 'a'.repeat(100);
    const chunks = chunkHtmlForTelegram(input, 30);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join('')).toBe(input);
  });

  it('does not split inside <pre><code>...</code></pre>', () => {
    const fence = '<pre><code>line1\nline2\nline3</code></pre>';
    const input = `before\n\n${fence}\n\nafter`;
    const chunks = chunkHtmlForTelegram(input, 30);
    const fenceChunk = chunks.find((c) => c.includes('<pre><code>'));
    expect(fenceChunk).toBeDefined();
    expect(fenceChunk!.includes('</code></pre>')).toBe(true);
  });

  it('does not split inside <a href="...">...</a>', () => {
    const link = '<a href="https://example.com/very/long/path">click here</a>';
    const input = `text ${link} more text`;
    const chunks = chunkHtmlForTelegram(input, 40);
    const linkChunk = chunks.find((c) => c.includes('<a href='));
    expect(linkChunk).toBeDefined();
    expect(linkChunk!.includes('</a>')).toBe(true);
  });

  it('does not split inside <b>...</b>', () => {
    const input = 'prefix <b>important text here</b> suffix';
    const chunks = chunkHtmlForTelegram(input, 25);
    const boldChunk = chunks.find((c) => c.includes('<b>'));
    expect(boldChunk).toBeDefined();
    expect(boldChunk!.includes('</b>')).toBe(true);
  });

  it('atomic block exceeding maxLen lands in own chunk (over limit acceptable)', () => {
    const fence = '<pre><code>' + 'x'.repeat(40) + '</code></pre>';
    const input = `pre\n\n${fence}\n\npost`;
    const chunks = chunkHtmlForTelegram(input, 30);
    const fenceChunk = chunks.find((c) => c.includes('<pre><code>'));
    expect(fenceChunk).toBeDefined();
    expect(fenceChunk!.length).toBeGreaterThan(30);
  });

  it('handles empty string', () => {
    expect(chunkHtmlForTelegram('', 100)).toEqual(['']);
  });

  it('handles input with only newlines', () => {
    const chunks = chunkHtmlForTelegram('\n\n\n\n', 5);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves nested inline tags as atomic', () => {
    const nested = '<b><i>nested bold italic</i></b>';
    const input = `pre ${nested} post`;
    const chunks = chunkHtmlForTelegram(input, 20);
    const tagChunk = chunks.find((c) => c.includes('<b>'));
    expect(tagChunk).toBeDefined();
    expect(tagChunk!.includes('</b>')).toBe(true);
  });
});
