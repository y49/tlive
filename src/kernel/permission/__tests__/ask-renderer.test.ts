import { describe, it, expect } from 'vitest';
import { parseAskBatch, renderAskBody, askButtons, buildAskUpdatedInput, extractAskAnswer, type AskBatch } from '../ask-renderer.js';

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

const THREE = {
  questions: [
    { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Second?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
    { question: 'Third?', options: [{ label: 'P' }, { label: 'Q' }] },
  ],
};

describe('parseAskBatch', () => {
  it('keeps every question in the batch — CC sends up to four per call', () => {
    const batch = parseAskBatch(THREE)!;
    expect(batch.questions.map((q) => q.question)).toEqual(['First?', 'Second?', 'Third?']);
    expect(batch.questions[1].multiSelect).toBe(true);
  });

  it('returns null for malformed input — CC should report the error itself', () => {
    expect(parseAskBatch({})).toBeNull();
    expect(parseAskBatch({ questions: [] })).toBeNull();
    expect(parseAskBatch({ questions: [{ question: 'Q?', options: [{ label: 'only-one' }] }] })).toBeNull();
  });

  it('rejects the whole batch when ANY question is malformed', () => {
    // Partial acceptance is the bug class this feature exists to kill: a
    // dropped question becomes a silently missing answer. All or nothing.
    const mixed = { questions: [THREE.questions[0], { question: 'Bad?', options: [{ label: 'lonely' }] }] };
    expect(parseAskBatch(mixed)).toBeNull();
  });
});

describe('renderAskBody', () => {
  it('renders header, question and numbered options with descriptions', () => {
    const { title, body } = renderAskBody(parseAskBatch(INPUT)!, 0);
    expect(title).toBe('Question');
    expect(body).toBe(
      '*Color*\n\nWhat is your favorite color?\n\n' +
      '**1.** Red — Warm, bold, energetic.\n' +
      '**2.** Blue — Cool, calm, classic.',
    );
  });

  it('omits the in-body option list entirely when no option has a description (buttons carry the labels)', () => {
    const { body } = renderAskBody(parseAskBatch({ questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] })!, 0);
    expect(body).toBe('Q?');
  });

  it('keeps the in-body list when at least one option has a description', () => {
    const { body } = renderAskBody(parseAskBatch({ questions: [{ question: 'Q?', options: [{ label: 'A', description: 'the a' }, { label: 'B' }] }] })!, 0);
    expect(body).toContain('**1.** A — the a');
  });

  it('carries progress in the title for a multi-question batch, and renders the question at the cursor', () => {
    const batch = parseAskBatch(THREE)!;
    expect(renderAskBody(batch, 0).title).toBe('Question 1/3');
    expect(renderAskBody(batch, 1).title).toBe('Question 2/3');
    expect(renderAskBody(batch, 1).body).toContain('Second?');
    expect(renderAskBody(batch, 1).body).not.toContain('First?');
  });

  it('leaves a single-question title bare — no 1/1 noise', () => {
    expect(renderAskBody(parseAskBatch(INPUT)!, 0).title).toBe('Question');
  });
});

describe('askButtons', () => {
  const single = parseAskBatch({ questions: [{ question: 'Q?', options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }] }] })!;
  const multi = parseAskBatch({ questions: [{ question: 'Q?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }] }] })!;

  it('numbers the options for a single-select question', () => {
    expect(askButtons('r1', single, 0, []).slice(0, 3)).toEqual([
      { id: 'ask:r1:0', label: '1. Red' },
      { id: 'ask:r1:1', label: '2. Blue' },
      { id: 'ask:r1:2', label: '3. Green' },
    ]);
  });

  it('renders checkboxes + a live Submit(N) for a multi-select question', () => {
    expect(askButtons('r1', multi, 0, []).slice(0, 3)).toEqual([
      { id: 'asktoggle:r1:0', label: '▢ Red' },
      { id: 'asktoggle:r1:1', label: '▢ Blue' },
      { id: 'asktoggle:r1:2', label: '▢ Green' },
    ]);
    expect(askButtons('r1', multi, 0, [0, 2])[0].label).toBe('▣ Red');
    expect(askButtons('r1', multi, 0, [0, 1]).at(-2)).toEqual({ id: 'asksubmit:r1', label: 'Submit (2)' });
  });

  it('always ends with Skip', () => {
    expect(askButtons('r1', single, 0, []).at(-1)).toEqual({ id: 'askskip:r1', label: 'Skip' });
    expect(askButtons('r1', multi, 0, []).at(-1)).toEqual({ id: 'askskip:r1', label: 'Skip' });
  });

  it('offers Back only past the first question — a misclick on question 2 is recoverable', () => {
    const batch = parseAskBatch(THREE)!;
    expect(askButtons('r1', batch, 0, []).map((b) => b.id)).not.toContain('askback:r1');
    expect(askButtons('r1', batch, 2, []).map((b) => b.id)).toContain('askback:r1');
  });

  it('uses geometric checkbox glyphs, never an emoji-presentation character — project emoji allowlist is ⚠️ only', () => {
    const labels = askButtons('r1', multi, 0, [1]).map((b) => b.label).join(' ');
    expect(labels).toContain('▣');
    expect(labels).toContain('▢');
    // U+2600-27BF (Misc Symbols/Dingbats, includes ☑ U+2611 / ☐ U+2610) would
    // render as a colorful emoji on Telegram — our glyphs live in Geometric
    // Shapes (U+25A0-25FF) instead, which stays monochrome text.
    expect(labels).not.toMatch(/[☀-➿️]/);
  });
});

describe('buildAskUpdatedInput (allow + updatedInput, the documented/native answer path)', () => {
  const answersOf = (batch: AskBatch, m: Record<number, string[]>) => new Map(Object.entries(m).map(([k, v]) => [Number(k), v]));

  it('spreads the ORIGINAL tool input rather than rebuilding it', () => {
    // CC's own submit path returns {...input, answers}. Rebuilding the
    // questions array is what silently dropped questions 2..N.
    const batch = parseAskBatch(THREE)!;
    const ui = buildAskUpdatedInput(THREE, batch, answersOf(batch, { 0: ['A'], 1: ['X', 'Y'], 2: ['Q'] })) as { questions: unknown[]; answers: Record<string, string> };
    expect(ui.questions).toBe(THREE.questions); // same reference — nothing reconstructed
    expect(ui.answers).toEqual({ 'First?': 'A', 'Second?': 'X, Y', 'Third?': 'Q' });
  });

  it('maps question text → answer for a single-question batch', () => {
    const batch = parseAskBatch(INPUT)!;
    const ui = buildAskUpdatedInput(INPUT, batch, answersOf(batch, { 0: ['Blue'] })) as { answers: Record<string, string> };
    expect(ui.answers).toEqual({ 'What is your favorite color?': 'Blue' });
  });

  it('preserves unrelated keys the tool input carried', () => {
    const withExtra = { ...INPUT, someFutureField: 42 };
    const batch = parseAskBatch(withExtra)!;
    const ui = buildAskUpdatedInput(withExtra, batch, answersOf(batch, { 0: ['Red'] })) as Record<string, unknown>;
    expect(ui.someFutureField).toBe(42);
  });
});

describe('extractAskAnswer (settled card readback)', () => {
  it('reads every answer back out of updatedInput.answers', () => {
    const batch = parseAskBatch(THREE)!;
    const ui = buildAskUpdatedInput(THREE, batch, new Map([[0, ['A']], [1, ['X']], [2, ['Q']]]));
    expect(extractAskAnswer(ui)).toBe('A; X; Q');
  });

  it('returns null when there is no answers object', () => {
    expect(extractAskAnswer({})).toBeNull();
    expect(extractAskAnswer(null)).toBeNull();
  });
});
