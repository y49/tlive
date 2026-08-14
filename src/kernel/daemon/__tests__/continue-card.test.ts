import { describe, it, expect } from 'vitest';
import { buildContinueCardBody } from '../bootstrap.js';

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

