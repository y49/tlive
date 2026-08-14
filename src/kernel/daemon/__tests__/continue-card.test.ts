import { describe, it, expect } from 'vitest';
import { buildContinueCardBody, idleDetail } from '../bootstrap.js';

describe('buildContinueCardBody', () => {
  it('wraps the excerpt in an expandable quote and ends with the quote-reply hint', () => {
    const body = buildContinueCardBody('All green.');
    expect(body).toBe('\n>! All green.\n\n*Reply to this message to continue.*');
  });

  it('quotes every line, blank lines included (paragraphs survive)', () => {
    expect(buildContinueCardBody('a\n\nb')).toBe('\n>! a\n>! \n>! b\n\n*Reply to this message to continue.*');
  });

  it('omits the quote entirely when there is no excerpt', () => {
    expect(buildContinueCardBody('')).toBe('\n*Reply to this message to continue.*');
  });

  it('runs the excerpt pipeline (headings become bold, code blocks survive)', () => {
    const body = buildContinueCardBody('## T\n\n```\nls\n```');
    expect(body).toContain('>! **T**');
    expect(body).toContain('>! `ls`');
  });
});

describe('idleDetail', () => {
  it('quotes the sentence the Stop hook recorded', () => {
    expect(idleDetail('Fixed the retry path; 932 tests pass', 'Claude is waiting for your input'))
      .toBe('Fixed the retry path; 932 tests pass');
  });

  it('says nothing when the only thing on record is this hook\'s own boilerplate', () => {
    // The idle notification's own message becomes the session's lastMessage
    // moments later, so without this guard the NEXT idle notification for the
    // same session would quote "Claude is waiting for your input" as if Claude
    // had said it.
    expect(idleDetail('Claude is waiting for your input', 'Claude is waiting for your input')).toBe('');
  });

  it('says nothing when the session has no recorded message at all', () => {
    expect(idleDetail(undefined, 'Claude is waiting for your input')).toBe('');
  });

  it('runs the excerpt pipeline, so raw markdown never leaks into a toast', () => {
    expect(idleDetail('## Done\n\nAll green.', 'x')).not.toContain('##');
  });
});
