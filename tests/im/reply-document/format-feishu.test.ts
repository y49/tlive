import { describe, it, expect } from 'vitest';
import { renderFeishu } from '../../../src/im/reply-document/format-feishu.js';
import { initialHudState } from '../../../src/im/hud/state.js';

const baseState = (overrides: Record<string, unknown> = {}) => ({
  ...initialHudState({
    sessionShortId: '8cdfcfb', workspaceName: 'tlive',
    gitBranch: 'feat/v1.0', provider: 'claude' as const,
    model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 5,
    startedAtMs: 0, costSession: 0.18,
  }),
  ...overrides,
});

describe('renderFeishu — header.template', () => {
  it.each([
    [{}, 'blue', '◐'],
    [{ askPending: true }, 'turquoise', '❓'],
    [{ currentActivity: { kind: 'waiting_permission', toolName: 'Bash', elapsedMs: 0 } }, 'yellow', '⏸'],
    [{ isFrozen: true }, 'green', '✓'],
    [{ isErrored: true, errorSummary: 'x' }, 'red', '❌'],
  ])('state=%j → template %s prefix %s', (overrides, template, prefix) => {
    const r: any = renderFeishu(baseState(overrides), '');
    expect(r.card.header.template).toBe(template);
    expect(r.card.header.title.content).toContain(prefix);
  });
});

describe('renderFeishu — body order: markdown / hr / status / note', () => {
  it('elements 顺序固定', () => {
    const r: any = renderFeishu(baseState({
      contextUsedTok: 64_000,
      toolTally: new Map([['Read', 3]]),
      durationMs: 12_300,
      costThisTurn: 0.04,
    }), 'hello');
    const tags = r.card.body.elements.map((e: any) => e.tag);
    expect(tags).toEqual(['markdown', 'hr', 'markdown', 'note']);
    expect(r.card.body.elements[0].content).toContain('hello');
    expect(r.card.body.elements[2].content).toContain('Context');
    expect(r.card.body.elements[2].content).toContain('Read×3');
    expect(r.card.body.elements[3].elements[0].content).toContain('$0.04');
  });
  it('空 body 显示 placeholder', () => {
    const r: any = renderFeishu(baseState(), '');
    expect(r.card.body.elements[0].content).toBe('_thinking…_');
  });
});
