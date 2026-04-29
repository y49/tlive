import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../../src/im/util/html.js';

describe('escapeHtml', () => {
  it('escapes ampersand, less-than, greater-than in that order', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('1 < 2')).toBe('1 &lt; 2');
    expect(escapeHtml('3 > 2')).toBe('3 &gt; 2');
  });

  it('escapes a hostile <script> tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does NOT escape single or double quotes', () => {
    expect(escapeHtml(`it's "fine"`)).toBe(`it's "fine"`);
  });

  it('handles already-escaped entities by escaping the leading ampersand', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });
});
