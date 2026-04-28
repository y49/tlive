import { describe, it, expect } from 'vitest';
import {
  escapeMarkdownV2,
  buttonsToInlineKeyboard,
  replyMarkupToTelegram,
  clampCallbackData,
  formatHtml,
  escapeHtml,
} from '../../../src/platform/telegram/renderer.js';

describe('telegram/renderer', () => {
  it('escapes MarkdownV2 special characters', () => {
    expect(escapeMarkdownV2('hello_world!')).toBe('hello\\_world\\!');
    expect(escapeMarkdownV2('[link](url)')).toBe('\\[link\\]\\(url\\)');
  });

  it('clamps callbackData exceeding 64 bytes', () => {
    const long = 'x'.repeat(100);
    expect(clampCallbackData(long).length).toBeLessThanOrEqual(64);
  });

  it('buttonsToInlineKeyboard maps url + callback_data', () => {
    const kbd = buttonsToInlineKeyboard([
      [{ text: 'A', callbackData: 'cb-a' }, { text: 'Link', url: 'https://e.com' }],
    ]);
    expect(kbd).toEqual([[
      { text: 'A', callback_data: 'cb-a' },
      { text: 'Link', url: 'https://e.com' },
    ]]);
  });

  it('replyMarkupToTelegram: force_reply', () => {
    const m = replyMarkupToTelegram({ type: 'force_reply', placeholder: 'Type...' });
    expect(m).toEqual({ force_reply: true, input_field_placeholder: 'Type...' });
  });

  it('replyMarkupToTelegram: modal → undefined (unsupported)', () => {
    expect(replyMarkupToTelegram({ type: 'modal', formFields: [] })).toBeUndefined();
  });
});

describe('telegram/formatHtml', () => {
  it('escapes HTML entities in plain text', () => {
    expect(escapeHtml('A & <B> > C')).toBe('A &amp; &lt;B&gt; &gt; C');
  });

  it('passes plain prose through with HTML escapes', () => {
    expect(formatHtml('Hello, world.')).toBe('Hello, world.');
    expect(formatHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('renders **bold** and *italic*', () => {
    expect(formatHtml('this is **bold** and *italic*')).toBe('this is <b>bold</b> and <i>italic</i>');
  });

  it('renders inline `code` spans', () => {
    expect(formatHtml('use `npm install` here')).toBe('use <code>npm install</code> here');
  });

  it('renders triple-backtick fenced blocks with language tag', () => {
    const html = formatHtml('```ts\nconst x = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const x = 1;');
    expect(html).toContain('</code></pre>');
  });

  it('escapes HTML inside fenced code (e.g. < and &)', () => {
    const html = formatHtml('```\nx < y && z\n```');
    expect(html).toContain('x &lt; y &amp;&amp; z');
  });

  it('renders [label](url) links for http(s)/tg', () => {
    const html = formatHtml('see [docs](https://example.com)');
    expect(html).toBe('see <a href="https://example.com">docs</a>');
  });

  it('does NOT mis-escape stray hyphens or punctuation in prose', () => {
    // Regression: MarkdownV2 would 400 on stray `-` / `.` / `!` here.
    // HTML mode passes them through cleanly.
    const html = formatHtml('Hello! - this is a test.');
    expect(html).toBe('Hello! - this is a test.');
  });

  it('preserves bullet-line dashes (no <ul> in Telegram HTML)', () => {
    const html = formatHtml('- item one\n- item two');
    expect(html).toBe('- item one\n- item two');
  });

  it('handles a mixed code + prose answer end-to-end', () => {
    const html = formatHtml('Run `ls` then read:\n```bash\nls -al\n```\nDone.');
    expect(html).toContain('<code>ls</code>');
    expect(html).toContain('<pre><code class="language-bash">');
    expect(html).toContain('ls -al');
    expect(html).toContain('Done.');
  });
});
