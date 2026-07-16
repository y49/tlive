import { describe, it, expect } from 'vitest';
import { renderAskCard, buildAskAnswerMessage } from '../ask-renderer.js';

const INPUT = {
  questions: [{
    question: 'What is your favorite color?',
    header: 'Color',
    multiSelect: false,
    options: [
      { label: 'Red', description: 'Warm, bold, energetic.' },
      { label: 'Blue', description: 'Cool, calm, classic.' },
    ],
  }],
};

describe('renderAskCard', () => {
  it('renders header, question and numbered options with descriptions', () => {
    const card = renderAskCard(INPUT)!;
    expect(card.title).toBe('Question');
    expect(card.body).toBe(
      '*Color*\n\nWhat is your favorite color?\n\n' +
      '**1.** Red — Warm, bold, energetic.\n' +
      '**2.** Blue — Cool, calm, classic.',
    );
    expect(card.options.map((o) => o.label)).toEqual(['Red', 'Blue']);
    expect(card.multiSelect).toBe(false);
  });

  it('carries the raw question text on the card (review Minor 5: single source of truth, no re-extraction by callers)', () => {
    const card = renderAskCard(INPUT)!;
    expect(card.question).toBe('What is your favorite color?');
  });

  it('omits the header chip when absent', () => {
    const card = renderAskCard({ questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] })!;
    expect(card.body.startsWith('Q?')).toBe(true);
  });

  it('omits the em-dash when an option has no description', () => {
    const card = renderAskCard({ questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] })!;
    expect(card.body).toContain('**1.** A\n');
    expect(card.body).not.toContain('A —');
  });

  it('only renders the first question (multi-question batches are flattened)', () => {
    const two = { questions: [INPUT.questions[0], { question: 'Second?', options: [{ label: 'X' }, { label: 'Y' }] }] };
    expect(renderAskCard(two)!.body).not.toContain('Second?');
  });

  it('returns null for malformed input — CC should report the error itself', () => {
    expect(renderAskCard({})).toBeNull();
    expect(renderAskCard({ questions: [] })).toBeNull();
    expect(renderAskCard({ questions: [{ question: 'Q?', options: [{ label: 'only-one' }] }] })).toBeNull();
  });
});

describe('buildAskAnswerMessage', () => {
  it('states the source, the selection, and a synthetic tool output', () => {
    const msg = buildAskAnswerMessage(INPUT.questions[0].question, ['Blue']);
    expect(msg).toContain('User answered via tlive');
    expect(msg).toContain('Selected: Blue');
    expect(msg).toContain('"What is your favorite color?": "Blue"');
    expect(msg).toContain('do NOT call AskUserQuestion again');
  });

  it('joins multiple selections', () => {
    expect(buildAskAnswerMessage('Q?', ['A', 'B'])).toContain('Selected: A, B');
  });
});
