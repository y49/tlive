import { describe, it, expect } from 'vitest';
import { markdownToTelegram, markdownToDiscordChunks, markdownToFeishu, markdownToHtml, truncateLongCodeBlocks } from '../markdown/index.js';

describe('Telegram rendering', () => {
  it('converts bold', () => {
    expect(markdownToTelegram('**hello**')).toContain('<b>hello</b>');
  });

  it('converts inline code', () => {
    expect(markdownToTelegram('`code`')).toContain('<code>code</code>');
  });

  it('converts code blocks', () => {
    const result = markdownToTelegram('```js\nconsole.log()\n```');
    expect(result).toContain('<pre>');
    expect(result).toContain('console.log()');
  });

  it('strips unsupported HTML tags', () => {
    const result = markdownToTelegram('# Heading\nparagraph');
    // Telegram doesn't support <h1>, should be plain text or bold
    expect(result).not.toContain('<h1>');
  });

  it('converts <br> from markdown hard break to newline', () => {
    // CommonMark hard break: two trailing spaces before newline -> <br>
    // Telegram HTML parse mode does NOT support <br> and rejects it with
    // 400 Bad Request: can't parse entities: Unsupported start tag "br".
    const result = markdownToTelegram('line one  \nline two');
    expect(result).not.toContain('<br');
    expect(result).toContain('line one');
    expect(result).toContain('line two');
  });

  it('converts backslash hard break to newline', () => {
    // CommonMark hard break: trailing backslash -> <br>
    const result = markdownToTelegram('line one\\\nline two');
    expect(result).not.toContain('<br');
    expect(result).toContain('line one');
    expect(result).toContain('line two');
  });
});

describe('Discord chunking', () => {
  it('returns single chunk for short text', () => {
    const chunks = markdownToDiscordChunks('hello world');
    expect(chunks).toHaveLength(1);
  });

  it('chunks at 2000 chars', () => {
    const long = 'x'.repeat(3000);
    const chunks = markdownToDiscordChunks(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('balances code fences across chunks', () => {
    const md = '```\n' + 'x'.repeat(2500) + '\n```';
    const chunks = markdownToDiscordChunks(md);
    // Each chunk with a code block should be properly fenced
    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0); // even number = balanced
    }
  });
});

describe('Feishu rendering', () => {
  it('passes through markdown unchanged', () => {
    const md = '**bold** and `code`';
    expect(markdownToFeishu(md)).toBe(md);
  });
});

describe('markdownToHtml improvements', () => {
  it('converts tables to <pre> monospace', () => {
    const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
    const html = markdownToHtml(md);
    expect(html).toContain('<pre>');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).not.toContain('<table');
  });

  it('renders nested lists with indentation', () => {
    const md = '- parent\n  - child\n    - grandchild';
    const html = markdownToHtml(md);
    expect(html).toContain('• parent');
    expect(html).toContain('  • child');
    expect(html).toContain('    • grandchild');
  });

  it('renders ordered lists with numbers', () => {
    const md = '1. first\n2. second\n3. third';
    const html = markdownToHtml(md);
    expect(html).toContain('1. first');
    expect(html).toContain('2. second');
    expect(html).toContain('3. third');
  });

  it('strips code block language class attributes', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const html = markdownToHtml(md);
    expect(html).toContain('<pre>');
    expect(html).toContain('const x = 1;');
    expect(html).not.toContain('class=');
    expect(html).not.toContain('language-');
  });

  it('converts blockquote', () => {
    const md = '> This is a quote';
    const html = markdownToHtml(md);
    expect(html).toMatch(/❝.*This is a quote/);
  });
});

describe('code block truncation', () => {
  it('truncates code blocks over 50 lines', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
    const md = '```\n' + lines.join('\n') + '\n```';
    const result = truncateLongCodeBlocks(md);
    expect(result).toContain('line 1');
    expect(result).toContain('line 30');
    expect(result).not.toContain('line 31');
    expect(result).toContain('... (40 lines omitted)');
    expect(result).toContain('line 71');
    expect(result).toContain('line 80');
  });

  it('does not truncate short code blocks', () => {
    const md = '```\nshort\n```';
    expect(truncateLongCodeBlocks(md)).toBe(md);
  });

  it('respects custom maxLines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const md = '```\n' + lines.join('\n') + '\n```';
    const result = truncateLongCodeBlocks(md, 10);
    expect(result).toContain('... (');
  });

  it('handles multiple code blocks independently', () => {
    const long = Array.from({ length: 60 }, (_, i) => `a${i}`).join('\n');
    const md = '```\n' + long + '\n```\nMiddle text\n```\nshort code\n```';
    const result = truncateLongCodeBlocks(md);
    expect(result).toContain('... (');
    expect(result).toContain('short code');
  });
});
