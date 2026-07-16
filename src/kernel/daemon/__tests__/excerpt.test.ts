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
    // Regression guard: with unscaled HEAD_BUDGET/TAIL_BUDGET constants (2500/800),
    // a small budget like 60 made breakAt/breakAtEnd's internal `s.length <= max`
    // guard return the ENTIRE string for both head and tail, producing
    // `${md}\n\n⋯ -443 chars omitted ⋯\n\n${md}` — the whole source duplicated
    // around a negative omission count. Output must never exceed the source length.
    expect(out.length).toBeLessThanOrEqual(md.length);
    // The whole source must not appear twice (e.g. "First sentence here." repeated).
    expect(out.split('First sentence here.').length - 1).toBe(1);
  });

  it('never exceeds the source length or duplicates it for a small budget (regression)', () => {
    const md = 'First sentence here. Second sentence here. ' + 'x'.repeat(400);
    const out = excerptForCard(md, 60);
    expect(out.length).toBeLessThanOrEqual(md.length);
    expect(out).not.toMatch(/⋯ -\d+ chars omitted ⋯/); // omission count must never be negative
    // The 400-char filler run must appear at most once (not once per duplicated copy).
    expect(out.split('x'.repeat(400)).length).toBeLessThanOrEqual(2);
  });

  it('breaks the head at a real sentence boundary, not mid-word, when the middle has real prose', () => {
    const sentence =
      'Alpha bravo charlie delta echo foxtrot golf hotel indigo juliet kilo lima mike november oscar. ';
    // Fewer reps (e.g. 30, ~2876 chars) sit under the default 3500 budget and
    // never enter the truncation branch at all — 40 reps clears it so
    // breakAt() actually fires against real sentence boundaries.
    const md = sentence.repeat(40) + 'FINAL-QUESTION: what next?';
    const out = excerptForCard(md, 3500);
    const [headPart] = out.split('\n\n⋯');
    // Must end exactly at a sentence boundary (period) rather than a mid-word hard cut.
    expect(headPart.endsWith('.')).toBe(true);
    // Must have broken earlier than the raw HEAD_BUDGET cutoff, proving the
    // paragraph/sentence boundary search actually fired instead of falling
    // back to the hard-cut branch (as the all-'m' filler in the test below does).
    expect(headPart.length).toBeLessThan(2500);
    expect(out).toContain('FINAL-QUESTION');
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
