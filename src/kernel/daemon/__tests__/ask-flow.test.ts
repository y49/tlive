import { describe, it, expect, beforeEach } from 'vitest';
import { AskFlow } from '../ask-flow.js';
import { parseAskBatch } from '../../permission/ask-renderer.js';

const THREE_INPUT = {
  questions: [
    { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Second?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
    { question: 'Third?', options: [{ label: 'P' }, { label: 'Q' }] },
  ],
};
const ONE_INPUT = { questions: [{ question: 'Only?', options: [{ label: 'A' }, { label: 'B' }] }] };

let flow: AskFlow;
const begin = (rid: string, input: unknown) => flow.begin(rid, parseAskBatch(input)!, input);

beforeEach(() => { flow = new AskFlow(); });

describe('unknown / finished requests', () => {
  it('reports stale for every action on an unknown request', () => {
    for (const step of [flow.pick('nope', 0), flow.submit('nope'), flow.toggle('nope', 0), flow.back('nope')]) {
      expect(step).toEqual({ kind: 'stale' });
    }
  });

  it('peek returns undefined for an unknown request', () => {
    expect(flow.peek('nope')).toBeUndefined();
  });

  it('isolates requests from each other', () => {
    begin('r1', THREE_INPUT); begin('r2', THREE_INPUT);
    flow.pick('r1', 0);
    expect(flow.peek('r1')!.cursor).toBe(1);
    expect(flow.peek('r2')!.cursor).toBe(0);
  });
});

describe('single-question batch — unchanged one-tap behaviour', () => {
  beforeEach(() => begin('r1', ONE_INPUT));

  it('answers immediately on a pick', () => {
    const step = flow.pick('r1', 1);
    expect(step.kind).toBe('answered');
    expect((step as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers).toEqual({ 'Only?': 'B' });
  });

  it('consumes the request so a double-tap cannot answer twice', () => {
    flow.pick('r1', 0);
    expect(flow.pick('r1', 1)).toEqual({ kind: 'stale' });
  });
});

describe('multi-question batch', () => {
  beforeEach(() => begin('r1', THREE_INPUT));

  it('advances instead of answering until the last question is done', () => {
    expect(flow.pick('r1', 0)).toEqual({ kind: 'render', cursor: 1 });   // First? -> A
    flow.toggle('r1', 0); flow.toggle('r1', 1);
    expect(flow.submit('r1')).toEqual({ kind: 'render', cursor: 2 });    // Second? -> X, Y

    const step = flow.pick('r1', 1);                                      // Third? -> Q
    expect(step.kind).toBe('answered');
    expect((step as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers)
      .toEqual({ 'First?': 'A', 'Second?': 'X, Y', 'Third?': 'Q' });
  });

  it('carries the original tool input through to the answer', () => {
    flow.pick('r1', 0); flow.toggle('r1', 0); flow.submit('r1');
    const step = flow.pick('r1', 0) as { updatedInput: { questions: unknown } };
    expect(step.updatedInput.questions).toBe(THREE_INPUT.questions);
  });

  it('scopes checkbox picks to the current question', () => {
    flow.pick('r1', 0);
    flow.toggle('r1', 1);
    expect(flow.peek('r1')!.picks).toEqual([1]);
    flow.submit('r1');
    expect(flow.peek('r1')!.picks).toEqual([]); // question 3 starts clean
  });

  it('keeps checkbox picks sorted and deduped', () => {
    flow.pick('r1', 0);
    flow.toggle('r1', 1); flow.toggle('r1', 0); flow.toggle('r1', 1); flow.toggle('r1', 1);
    expect(flow.peek('r1')!.picks).toEqual([0, 1]);
  });
});

describe('back', () => {
  beforeEach(() => begin('r1', THREE_INPUT));

  it('steps back and drops that question\'s answer so it is re-asked', () => {
    flow.pick('r1', 0);
    expect(flow.back('r1')).toEqual({ kind: 'render', cursor: 0 });
    flow.pick('r1', 1);                                        // re-answer First? as B
    flow.toggle('r1', 0); flow.submit('r1');
    const step = flow.pick('r1', 0) as { updatedInput: { answers: Record<string, string> } };
    expect(step.updatedInput.answers['First?']).toBe('B');
  });

  it('is a no-op on the first question', () => {
    expect(flow.back('r1')).toEqual({ kind: 'noop' });
  });

  it('clears the checkbox picks of the question being left', () => {
    flow.pick('r1', 0); flow.toggle('r1', 0);
    flow.back('r1');
    flow.pick('r1', 0);
    expect(flow.peek('r1')!.picks).toEqual([]);
  });
});

describe('input validation — a bad click must never mutate state', () => {
  beforeEach(() => begin('r1', THREE_INPUT));

  it('ignores an out-of-range pick', () => {
    expect(flow.pick('r1', 9)).toEqual({ kind: 'noop' });
    expect(flow.peek('r1')!.cursor).toBe(0);
  });

  it('ignores an out-of-range toggle', () => {
    flow.pick('r1', 0);
    expect(flow.toggle('r1', 9)).toEqual({ kind: 'noop' });
    expect(flow.peek('r1')!.picks).toEqual([]);
  });

  it('refuses a pick on a multi-select question and a toggle on a single-select one', () => {
    expect(flow.toggle('r1', 0)).toEqual({ kind: 'noop' });   // question 1 is single-select
    flow.pick('r1', 0);
    expect(flow.pick('r1', 0)).toEqual({ kind: 'noop' });     // question 2 is multi-select
  });

  it('refuses an empty submit — zero ticks and no text is not an answer', () => {
    flow.pick('r1', 0);
    expect(flow.submit('r1')).toEqual({ kind: 'noop' });
    expect(flow.submit('r1', '   ')).toEqual({ kind: 'noop' });
    expect(flow.peek('r1')!.cursor).toBe(1);
  });
});

describe('free text', () => {
  it('answers a single-select question with typed text alone', () => {
    begin('r1', ONE_INPUT);
    const step = flow.submit('r1', 'something else') as { kind: string; updatedInput: { answers: Record<string, string> } };
    expect(step.kind).toBe('answered');
    expect(step.updatedInput.answers).toEqual({ 'Only?': 'something else' });
  });

  it('rides along with any ticked boxes on a multi-select question', () => {
    begin('r1', THREE_INPUT);
    flow.pick('r1', 0);
    flow.toggle('r1', 0);
    flow.submit('r1', 'and this');
    flow.pick('r1', 0);
    expect(flow.peek('r1')).toBeUndefined();
  });

  it('joins ticks and text into one answer', () => {
    begin('r1', THREE_INPUT);
    flow.pick('r1', 0);
    flow.toggle('r1', 1);
    flow.submit('r1', 'and this');
    const step = flow.pick('r1', 0) as { updatedInput: { answers: Record<string, string> } };
    expect(step.updatedInput.answers['Second?']).toBe('Y, and this');
  });
});

describe('end', () => {
  it('frees the request — no leak across the daemon lifetime', () => {
    begin('r1', THREE_INPUT);
    flow.end('r1');
    expect(flow.peek('r1')).toBeUndefined();
    expect(flow.pick('r1', 0)).toEqual({ kind: 'stale' });
  });

  it('is safe to call for an unknown request', () => {
    expect(() => flow.end('nope')).not.toThrow();
  });
});
