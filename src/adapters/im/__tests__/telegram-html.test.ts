import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, escapeHtml } from '../telegram-html.js';

describe('escapeHtml', () => {
  it('escapes the three HTML-significant chars', () => {
    expect(escapeHtml('a<b>&"c"')).toBe('a&lt;b&gt;&amp;"c"');
  });
});

describe('mdToTelegramHtml', () => {
  it('converts a code fence to <pre><code> with a language class', () => {
    expect(mdToTelegramHtml('```bash\nls -la\n```')).toBe('<pre><code class="language-bash">ls -la</code></pre>');
    expect(mdToTelegramHtml('```\nplain\n```')).toBe('<pre><code>plain</code></pre>');
  });

  it('truncates long fences (> 14 lines) to 12 lines + a more-lines marker', () => {
    // TG 不允许 pre 嵌 blockquote(真机实证外层被丢),改为截断 + 提示
    const body = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const out = mdToTelegramHtml('```\n' + body + '\n```');
    const head = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n');
    expect(out).toBe(`<pre><code>${head}</code></pre>\n<i>… +8 more lines — open the dashboard for the full text</i>`);
  });

  it('does not truncate fences of exactly 14 lines', () => {
    const body = Array.from({ length: 14 }, (_, i) => `l${i}`).join('\n');
    const out = mdToTelegramHtml('```\n' + body + '\n```');
    expect(out).toBe(`<pre><code>${body}</code></pre>`);
  });

  it('escapes HTML inside fences so agent content cannot inject markup', () => {
    const out = mdToTelegramHtml('```bash\necho "</pre><b>x</b>"\n```');
    expect(out).toContain('&lt;/pre&gt;&lt;b&gt;x&lt;/b&gt;');
    expect(out.match(/<pre>/g)).toHaveLength(1);
  });

  it('converts **bold** and `inline code` outside fences', () => {
    expect(mdToTelegramHtml('**risky** run `rm -rf /` now')).toBe('<b>risky</b> run <code>rm -rf /</code> now');
  });

  it('escapes HTML in plain text and inline code', () => {
    expect(mdToTelegramHtml('a < b & `c<d>`')).toBe('a &lt; b &amp; <code>c&lt;d&gt;</code>');
  });

  it('keeps diff fence content verbatim (escaped, no per-line styling)', () => {
    const out = mdToTelegramHtml('```diff\n- old\n+ new\n```');
    expect(out).toBe('<pre><code class="language-diff">- old\n+ new</code></pre>');
  });

  it('handles mixed prose + fence documents', () => {
    const out = mdToTelegramHtml('Deploy script\n```bash\nnpm run deploy\n```\n⚠️ **risky command**');
    expect(out).toBe('Deploy script\n<pre><code class="language-bash">npm run deploy</code></pre>\n⚠️ <b>risky command</b>');
  });
});

describe('mdToTelegramHtml — rich inline + block markup', () => {
  it('converts *italic* without clobbering **bold**', () => {
    expect(mdToTelegramHtml('*Deploy to prod*')).toBe('<i>Deploy to prod</i>');
    expect(mdToTelegramHtml('**risky** and *careful*')).toBe('<b>risky</b> and <i>careful</i>');
  });

  it('converts ~~strike~~ and ||spoiler||', () => {
    expect(mdToTelegramHtml('~~gone~~ and ||secret||')).toBe('<s>gone</s> and <tg-spoiler>secret</tg-spoiler>');
  });

  it('converts a > blockquote (single and multi-line)', () => {
    expect(mdToTelegramHtml('> one line')).toBe('<blockquote>one line</blockquote>');
    expect(mdToTelegramHtml('> a\n> b')).toBe('<blockquote>a\nb</blockquote>');
  });

  it('converts >! to an expandable blockquote', () => {
    expect(mdToTelegramHtml('>! long thing\n>! second')).toBe('<blockquote expandable>long thing\nsecond</blockquote>');
  });

  it('applies inline markup and escaping inside a blockquote', () => {
    expect(mdToTelegramHtml('> **bad** <x> `q`')).toBe('<blockquote><b>bad</b> &lt;x&gt; <code>q</code></blockquote>');
  });

  it('mixes prose, blockquote, and a fence in one document', () => {
    const md = '🛡 **Bash**\n*Deploy the app*\n```bash\nnpm run deploy\n```\n> reply to continue';
    expect(mdToTelegramHtml(md)).toBe(
      '🛡 <b>Bash</b>\n<i>Deploy the app</i>\n<pre><code class="language-bash">npm run deploy</code></pre>\n<blockquote>reply to continue</blockquote>',
    );
  });

  it('leaves a bare > inside a fence untouched (redirection is not a quote)', () => {
    expect(mdToTelegramHtml('```bash\necho hi > /tmp/x\n```')).toBe('<pre><code class="language-bash">echo hi &gt; /tmp/x</code></pre>');
  });
});
