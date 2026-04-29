import { describe, it, expect } from 'vitest';
import { markdownToTelegramHtml } from '../../../src/im/reply-document/markdown.js';

describe('markdownToTelegramHtml — extras', () => {
  it('blockquote: > quote → <blockquote>', () => {
    expect(markdownToTelegramHtml('> hello')).toBe('<blockquote>hello</blockquote>');
  });
  it('hr: --- → emoji bar', () => {
    expect(markdownToTelegramHtml('---')).toBe('▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰');
  });
  it('autolink 裸 URL', () => {
    expect(markdownToTelegramHtml('see https://example.com/x')).toContain('<a href="https://example.com/x">https://example.com/x</a>');
  });
  it('[text](url) → anchor', () => {
    expect(markdownToTelegramHtml('[click](https://x.com)')).toContain('<a href="https://x.com">click</a>');
  });
  it('阻止非 http/https scheme', () => {
    expect(markdownToTelegramHtml('[evil](javascript:alert(1))')).not.toContain('<a');
  });
  it('fence code 不被 hr/autolink 误吃', () => {
    const md = '```\nhttps://no.touch\n---\n```';
    const out = markdownToTelegramHtml(md);
    expect(out).toContain('<pre>');
    expect(out).not.toContain('<a href=');
    expect(out).not.toContain('▰▰');
  });
  it('inline code + bold + italic 仍 work', () => {
    const out = markdownToTelegramHtml('**bold** *it* `c`');
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('<i>it</i>');
    expect(out).toContain('<code>c</code>');
  });
  it('# heading → <b>', () => {
    expect(markdownToTelegramHtml('# T')).toBe('<b>T</b>');
  });
});
