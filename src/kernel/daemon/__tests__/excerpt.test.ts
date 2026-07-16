import { describe, it, expect } from 'vitest';
import { excerptForCard } from '../excerpt.js';

describe('excerptForCard', () => {
  it('keeps short prose untouched', () => {
    expect(excerptForCard('All done. Tests pass.')).toBe('All done. Tests pass.');
  });

  it('converts headings to bold, preserving the blank line before them', () => {
    // \s{0,3} would eat the newline — must use [ \t]{0,3}
    expect(excerptForCard('Intro:\n\n## Section\n\nBody')).toBe('Intro:\n\n**Section**\n\nBody');
  });

  it('converts unordered list markers to bullets', () => {
    expect(excerptForCard('- one\n- two')).toBe('• one\n• two');
  });

  it('keeps short fenced code as per-line inline code (never an orphan lead-in)', () => {
    expect(excerptForCard('Looks like:\n\n```\nnpm test\n```')).toBe('Looks like:\n\n`npm test`');
  });

  it('truncates long fenced code with a marker', () => {
    const code = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const out = excerptForCard('X:\n\n```\n' + code + '\n```');
    expect(out).toContain('`e`');
    expect(out).not.toContain('`f`');
    expect(out).toContain('*[+2 more lines]*');
  });

  it('flattens tables into compact rows and drops the separator line', () => {
    const md = '| Where | Now |\n|---|---|\n| tag | old |';
    expect(excerptForCard(md)).toBe('Where · Now\ntag · old');
  });

  it('preserves bold/italic/inline-code for the renderer', () => {
    expect(excerptForCard('**b** *i* `c`')).toBe('**b** *i* `c`');
  });

  it('collapses 3+ blank lines to one', () => {
    expect(excerptForCard('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('breaks at a sentence boundary rather than mid-word when over budget', () => {
    const md = 'First sentence here. Second sentence here. ' + 'x'.repeat(400);
    const out = excerptForCard(md, 60);
    expect(out.endsWith('…')).toBe(false); // head/tail form, not a naive cut
    expect(out).toContain('First sentence here.');
  });

  it('keeps head AND tail when way over budget, marking the omission', () => {
    const head = 'HEAD. ';
    const mid = 'm'.repeat(5000);
    const tail = ' TAIL-END.';
    const out = excerptForCard(head + mid + tail, 3500);
    expect(out).toContain('HEAD.');
    expect(out).toContain('TAIL-END.');
    expect(out).toMatch(/⋯ \d+ chars omitted ⋯/);
  });

  it('returns empty string for empty input', () => {
    expect(excerptForCard('')).toBe('');
  });

  it('handles a message that is nothing but a code block', () => {
    expect(excerptForCard('```\nls\n```')).toBe('`ls`');
  });
});
