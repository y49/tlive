import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, escapeHtml } from '../telegram-html.js';

describe('escapeHtml', () => {
  it('escapes the three HTML-significant chars', () => {
    expect(escapeHtml('a<b>&"c"')).toBe('a&lt;b&gt;&amp;"c"');
  });
});

describe('mdToTelegramHtml', () => {
  it('converts a code fence to <pre><code>', () => {
    expect(mdToTelegramHtml('```bash\nls -la\n```')).toBe('<pre><code>ls -la</code></pre>');
  });

  it('folds long fences (>= 8 lines) into an expandable blockquote', () => {
    const body = Array.from({ length: 9 }, (_, i) => `line${i}`).join('\n');
    const out = mdToTelegramHtml('```\n' + body + '\n```');
    expect(out).toBe(`<blockquote expandable><pre><code>${body}</code></pre></blockquote>`);
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
    expect(out).toBe('<pre><code>- old\n+ new</code></pre>');
  });

  it('handles mixed prose + fence documents', () => {
    const out = mdToTelegramHtml('Deploy script\n```bash\nnpm run deploy\n```\n⚠️ **risky command**');
    expect(out).toBe('Deploy script\n<pre><code>npm run deploy</code></pre>\n⚠️ <b>risky command</b>');
  });
});
