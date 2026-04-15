import { describe, it, expect, vi } from 'vitest';
import { TurnBuffer } from '../engine/turn-buffer.js';

describe('TurnBuffer', () => {
  it('accumulates reasoning, tools, and final message within a turn', () => {
    const onComplete = vi.fn();
    const tb = new TurnBuffer(onComplete);

    tb.push({ kind: 'reasoning_complete', text: 'thinking' });
    tb.push({ kind: 'tool_start', id: 't1', name: 'Read', input: { path: 'a.ts' } });
    tb.push({ kind: 'tool_start', id: 't2', name: 'Edit', input: { path: 'b.ts' } });
    tb.push({ kind: 'text_complete', text: 'Done!' });
    tb.completeTurn(1200, { inputTokens: 100, outputTokens: 50, costUsd: 0.01 });

    expect(onComplete).toHaveBeenCalledOnce();
    const summary = onComplete.mock.calls[0][0];
    expect(summary.reasoningText).toBe('thinking');
    expect(summary.toolsStarted).toHaveLength(2);
    expect(summary.finalText).toBe('Done!');
    expect(summary.durationMs).toBe(1200);
    expect(summary.cost?.costUsd).toBe(0.01);
  });

  it('resets on new turn', () => {
    const onComplete = vi.fn();
    const tb = new TurnBuffer(onComplete);

    tb.push({ kind: 'reasoning_complete', text: 'first' });
    tb.completeTurn(500, undefined);
    expect(onComplete.mock.calls[0][0].reasoningText).toBe('first');

    tb.push({ kind: 'reasoning_complete', text: 'second' });
    tb.completeTurn(500, undefined);
    expect(onComplete.mock.calls[1][0].reasoningText).toBe('second');
  });

  it('resetTurn clears state without emitting', () => {
    const onComplete = vi.fn();
    const tb = new TurnBuffer(onComplete);
    tb.push({ kind: 'reasoning_complete', text: 'x' });
    tb.resetTurn();
    tb.completeTurn(100, undefined);
    expect(onComplete.mock.calls[0][0].reasoningText).toBeUndefined();
  });
});
