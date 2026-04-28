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

  it('renders CJK bold — smoke case **饮料**', () => {
    expect(formatHtml('**饮料**')).toContain('<b>饮料</b>');
  });

  it('renders _italic_ underscored form', () => {
    expect(formatHtml('_italic_')).toContain('<i>italic</i>');
  });

  it('renders italic surrounded by plain text', () => {
    expect(formatHtml('plain *no spaces beside* text')).toContain('<i>no spaces beside</i>');
  });

  it('a*b*c — italic only when not joined to alphanumeric on boundary', () => {
    // The italic regex requires a non-word char (or start) before the opening *,
    // so `a*b*c` does NOT trigger italic — the opening * is preceded by 'a' (word char).
    expect(formatHtml('a*b*c')).not.toContain('<i>');
  });

  it('bold then italic nested — **bold _and italic_**', () => {
    const html = formatHtml('**bold _and italic_**');
    expect(html).toContain('<b>');
    expect(html).toContain('bold');
    // The italic inside the bold span: _and italic_ is processed inside the already-replaced text.
    // Since bold replacement happens first on the HTML-escaped string, the inner _italic_ IS matched.
    expect(html).toContain('<i>and italic</i>');
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
