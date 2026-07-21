import { describe, it, expect } from 'vitest';
import { renderAskCard, buildAskAnswerMessage, askMultiButtons, type AskOption } from '../ask-renderer.js';

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
  it("mimics CC's native answer feedback format (mined from the 2.1.216 binary)", () => {
    const msg = buildAskAnswerMessage(INPUT.questions[0].question, ['Blue']);
    expect(msg).toContain('Nothing failed');
    expect(msg).toContain('answered remotely via tlive');
    expect(msg).toContain('The user answered: [Answered What is your favorite color?]: Blue');
    expect(msg).toContain('Do not call AskUserQuestion again');
    expect(msg).toContain('continue with these answers in mind');
  });

  it('joins multiple selections', () => {
    expect(buildAskAnswerMessage('Q?', ['A', 'B'])).toContain(']: A, B');
  });
});

describe('askMultiButtons (Task 10)', () => {
  const options: AskOption[] = [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }];

  it('renders one checkbox button per option, unchecked when nothing is selected', () => {
    const buttons = askMultiButtons('r1', options, []);
    expect(buttons.slice(0, 3)).toEqual([
      { id: 'asktoggle:r1:0', label: '▢ Red' },
      { id: 'asktoggle:r1:1', label: '▢ Blue' },
      { id: 'asktoggle:r1:2', label: '▢ Green' },
    ]);
  });

  it('marks selected options with a filled checkbox', () => {
    const buttons = askMultiButtons('r1', options, [0, 2]);
    expect(buttons[0].label).toBe('▣ Red');
    expect(buttons[1].label).toBe('▢ Blue');
    expect(buttons[2].label).toBe('▣ Green');
  });

  it('appends a Submit(N) button carrying the live selection count', () => {
    expect(askMultiButtons('r1', options, []).at(-2)).toEqual({ id: 'asksubmit:r1', label: 'Submit (0)' });
    expect(askMultiButtons('r1', options, [0, 1]).at(-2)).toEqual({ id: 'asksubmit:r1', label: 'Submit (2)' });
  });

  it('appends a Skip button', () => {
    expect(askMultiButtons('r1', options, []).at(-1)).toEqual({ id: 'askskip:r1', label: 'Skip' });
  });

  it('uses geometric checkbox glyphs, never an emoji-presentation character — project emoji allowlist is ⚠️ only', () => {
    const labels = askMultiButtons('r1', options, [1]).map((b) => b.label).join(' ');
    expect(labels).toContain('▣');
    expect(labels).toContain('▢');
    // U+2600-27BF (Misc Symbols/Dingbats, includes ☑ U+2611 / ☐ U+2610) would
    // render as a colorful emoji on Telegram — our glyphs live in Geometric
    // Shapes (U+25A0-25FF) instead, which stays monochrome text.
    expect(labels).not.toMatch(/[\u2600-\u27BF\uFE0F]/);
  });
});
