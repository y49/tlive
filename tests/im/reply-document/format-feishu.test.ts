import { describe, it, expect } from 'vitest';
import { renderFeishu } from '../../../src/im/reply-document/format-feishu.js';
import { initialHudState } from '../../../src/im/hud/state.js';

const NOW_5S = 1_700_000_005_000;

const baseState = (overrides: Record<string, unknown> = {}) => ({
  ...initialHudState({
    sessionShortId: '8cdfcfb', workspaceName: 'tlive',
    gitBranch: 'feat/v1.0', provider: 'claude' as const,
    model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 5,
    startedAtMs: 1_700_000_000_000, costSession: 0.18,
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
    const r: any = renderFeishu(baseState(overrides), '', NOW_5S);
    expect(r.card.header.template).toBe(template);
    expect(r.card.header.title.content).toContain(prefix);
  });

  it('header.title uses #N · sid (turn → conversation round)', () => {
    const r: any = renderFeishu(baseState(), '', NOW_5S);
    expect(r.card.header.title.content).toContain('#5');
    expect(r.card.header.title.content).toContain('8cdfcfb');
  });

  it('header.subtitle is just the model id (model card label)', () => {
    const r: any = renderFeishu(baseState(), '', NOW_5S);
    expect(r.card.header.subtitle.content).toBe('opus-4-6');
  });
});

describe('renderFeishu — body element order (progress promoted)', () => {
  it('elements 顺序: progress / hr / body / hr / detail', () => {
    const r: any = renderFeishu(baseState({
      contextUsedTok: 64_000,
      toolTally: new Map([['Read', 3]]),
      durationMs: 12_300,
      costThisTurn: 0.04,
      isFrozen: true,
    }), 'hello', NOW_5S);
    const tags = r.card.body.elements.map((e: any) => e.tag);
    expect(tags).toEqual(['markdown', 'hr', 'markdown', 'hr', 'markdown']);
    // Element 0 = progress (always visible) — has tally + ⏱ + 💵
    expect(r.card.body.elements[0].content).toContain('Read×3');
    expect(r.card.body.elements[0].content).toContain('⏱ 12.3s');
    expect(r.card.body.elements[0].content).toContain('💵 $0.04');
    // Element 2 = body
    expect(r.card.body.elements[2].content).toContain('hello');
    // Element 4 = detail (turn header + Context + Σ session)
    expect(r.card.body.elements[4].content).toContain('💬 #5');
    expect(r.card.body.elements[4].content).toContain('Context');
    expect(r.card.body.elements[4].content).toContain('opus-4-6');
    expect(r.card.body.elements[4].content).toContain('Σ $0.18');
  });

  it('空 body 显示 placeholder', () => {
    const r: any = renderFeishu(baseState(), '', NOW_5S);
    expect(r.card.body.elements[2].content).toBe('_thinking…_');
  });
});

describe('v3.2.2 adaptive truth — unknown model / 0 cost (Feishu)', () => {
  it('progress: frozen with 0 cost suppresses 💵 segment', () => {
    const r: any = renderFeishu(
      baseState({ isFrozen: true, durationMs: 4_100, costThisTurn: 0 }),
      '',
      NOW_5S,
    );
    expect(r.card.body.elements[0].content).not.toContain('💵');
    expect(r.card.body.elements[0].content).toContain('⏱ 4.1s');
  });

  it('detail: unknown maxContext drops "(...)" suffix from title and shows tokens', () => {
    const r: any = renderFeishu(
      { ...baseState(), modelMaxContext: 0, contextUsedTok: 28_400 },
      '',
      NOW_5S,
    );
    const detail = r.card.body.elements[4].content;
    expect(detail).not.toMatch(/\(\d/);  // no "(200k)" parenthetical
    expect(detail).toContain('28.4k tokens');
    expect(detail).not.toContain('%');
  });

  it('detail: costSession 0 suppresses "Σ"', () => {
    const r: any = renderFeishu(
      { ...baseState(), costSession: 0 },
      '',
      NOW_5S,
    );
    expect(r.card.body.elements[4].content).not.toContain('Σ');
  });
});

describe('renderFeishu — live elapsed via now injection', () => {
  it('elapsed computed from now - startedAtMs when not frozen', () => {
    const r: any = renderFeishu(baseState(), '', NOW_5S);
    // Element 0 = progress markdown
    expect(r.card.body.elements[0].content).toContain('⏱ 5.0s');
  });

  it('elapsed uses durationMs when frozen', () => {
    const r: any = renderFeishu(baseState({ isFrozen: true, durationMs: 4_100 }), '', NOW_5S);
    expect(r.card.body.elements[0].content).toContain('⏱ 4.1s');
  });

  it('cost shows placeholder during turn', () => {
    const r: any = renderFeishu(baseState(), '', NOW_5S);
    expect(r.card.body.elements[0].content).toContain('💵 –.--');
  });

  it('cost shows real value when frozen', () => {
    const r: any = renderFeishu(baseState({ isFrozen: true, durationMs: 4_100, costThisTurn: 0.06 }), '', NOW_5S);
    expect(r.card.body.elements[0].content).toContain('💵 $0.06');
  });
});
