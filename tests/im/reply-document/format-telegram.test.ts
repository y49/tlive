import { describe, it, expect } from 'vitest';
import { renderTelegramReply, renderTelegramDetail } from '../../../src/im/reply-document/format-telegram.js';
import { initialHudState } from '../../../src/im/hud/state.js';

const baseState = (overrides: Record<string, unknown> = {}) => ({
  ...initialHudState({
    sessionShortId: '8cdfcfb', workspaceName: 'tlive',
    gitBranch: 'feat/v1.0', provider: 'claude' as const,
    model: 'claude-opus-4-7', modelMaxContext: 200_000, turnNumber: 5,
    startedAtMs: 1_700_000_000_000, costSession: 0.18,
  }),
  ...overrides,
});

const NOW_5S = 1_700_000_005_000;

describe('renderTelegramReply — banner', () => {
  it('thinking 默认', () => {
    const r = renderTelegramReply(baseState(), '', NOW_5S);
    expect(r.html).toContain('<b>◐ thinking</b>');
  });
  it('tool_running 显示 toolName', () => {
    const r = renderTelegramReply(baseState({
      currentActivity: { kind: 'tool_running', toolName: 'Read', toolArg: 'README.md', elapsedMs: 1200 },
    }), 'body', NOW_5S);
    expect(r.html).toContain('<b>◐ Read</b>');
  });
  it('askPending', () => {
    const r = renderTelegramReply(baseState({ askPending: true }), '', NOW_5S);
    expect(r.html).toContain('<b>❓ awaiting input</b>');
  });
  it('waiting_permission', () => {
    const r = renderTelegramReply(baseState({
      currentActivity: { kind: 'waiting_permission', toolName: 'Bash', elapsedMs: 0 },
    }), '', NOW_5S);
    expect(r.html).toContain('<b>⏸ waiting for permission · Bash</b>');
  });
  it('frozen done', () => {
    const r = renderTelegramReply(baseState({ isFrozen: true, durationMs: 4_100 }), '', NOW_5S);
    expect(r.html).toContain('<b>✓ done</b>');
  });
  it('errored', () => {
    const r = renderTelegramReply(baseState({ isErrored: true, errorSummary: 'oops' }), '', NOW_5S);
    expect(r.html).toContain('<b>❌ error · oops</b>');
  });
});

describe('renderTelegramReply — progress (always visible, live elapsed)', () => {
  it('elapsed computed from now - startedAtMs when not frozen', () => {
    const r = renderTelegramReply(baseState(), '', NOW_5S);
    expect(r.html).toContain('⏱ 5.0s');
  });
  it('elapsed uses durationMs when frozen', () => {
    const r = renderTelegramReply(baseState({ isFrozen: true, durationMs: 4_100 }), '', NOW_5S);
    expect(r.html).toContain('⏱ 4.1s');
  });
  it('cost shows placeholder during turn (not frozen)', () => {
    const r = renderTelegramReply(baseState(), '', NOW_5S);
    expect(r.html).toContain('💵 –.--');
  });
  it('cost shows real value when frozen', () => {
    const r = renderTelegramReply(baseState({ isFrozen: true, durationMs: 4_100, costThisTurn: 0.06 }), '', NOW_5S);
    expect(r.html).toContain('💵 $0.06');
  });
  it('tally chips appear in progress line', () => {
    const r = renderTelegramReply(baseState({
      toolTally: new Map([['Read', 3], ['Bash', 1]]),
    }), '', NOW_5S);
    expect(r.html).toContain('Read×3');
    expect(r.html).toContain('Bash×1');
  });
  it('progress is on second line (line 1 = banner, line 2 = progress)', () => {
    const r = renderTelegramReply(baseState(), '', NOW_5S);
    const lines = r.html.split('\n');
    expect(lines[0]).toMatch(/^<b>/);
    expect(lines[1]).toMatch(/⏱/);
  });
});

describe('renderTelegramReply — body', () => {
  it('empty body shows thinking placeholder', () => {
    const r = renderTelegramReply(baseState(), '', NOW_5S);
    expect(r.html).toContain('<i>thinking…</i>');
  });
  it('body markdown converted to HTML', () => {
    const r = renderTelegramReply(baseState(), '**bold** text', NOW_5S);
    expect(r.html).toContain('<b>bold</b>');
  });
  it('body fence code preserved as <pre><code>', () => {
    const r = renderTelegramReply(baseState(), '```ts\nconst x = 1;\n```', NOW_5S);
    expect(r.html).toContain('<pre><code');
  });
});

describe('renderTelegramDetail — <pre><code> card', () => {
  it('wraps content in <pre><code>...</code></pre>', () => {
    const r = renderTelegramDetail(baseState());
    expect(r.html.startsWith('<pre><code>')).toBe(true);
    expect(r.html.endsWith('</code></pre>')).toBe(true);
  });
  it('line 1 — turn header with #N · sid · model (maxK ctx)', () => {
    const r = renderTelegramDetail(baseState());
    expect(r.html).toContain('💬 #5');
    expect(r.html).toContain('8cdfcfb');
    expect(r.html).toContain('claude-opus-4-7');
    expect(r.html).toContain('(200.0k ctx)');
  });
  it('line 2 — git branch · workspace, omitted if no branch', () => {
    const withBranch = renderTelegramDetail(baseState());
    expect(withBranch.html).toContain('🌳 feat/v1.0 · tlive');

    const noBranch = renderTelegramDetail({ ...baseState(), gitBranch: undefined });
    expect(noBranch.html).not.toContain('🌳');
  });
  it('line 3 — context bar + tokens + Σ session', () => {
    const r = renderTelegramDetail(baseState({
      contextUsedTok: 44_200,
      costSession: 0.25,
    }));
    expect(r.html).toContain('22%');
    expect(r.html).toContain('44.2k/200.0k');
    expect(r.html).toContain('Σ $0.25');
  });
  it('appends quota lines when state.quotaBars non-empty', () => {
    const r = renderTelegramDetail(baseState({
      quotaBars: [{ label: '5h', pct: 45, resetsIn: '3h 57m' }],
    }));
    expect(r.html).toContain('5h');
    expect(r.html).toContain('45%');
    expect(r.html).toContain('3h 57m');
  });
});

describe('renderTelegramReply — defaults to Date.now() when now omitted', () => {
  it('omitting now still produces valid output', () => {
    const r = renderTelegramReply(baseState(), '', undefined);
    expect(r.html).toContain('⏱');
  });
});

describe('v3.2.2 adaptive truth — unknown model / 0 cost', () => {
  it('progress line: frozen with 0 cost suppresses 💵 segment', () => {
    const r = renderTelegramReply(
      baseState({ isFrozen: true, durationMs: 4_100, costThisTurn: 0 }),
      '',
      NOW_5S,
    );
    expect(r.html).not.toContain('💵');
    expect(r.html).toContain('⏱ 4.1s');
  });

  it('progress line: turn-running still shows 💵 –.-- placeholder regardless of cost', () => {
    const r = renderTelegramReply(baseState({ costThisTurn: 0 }), '', NOW_5S);
    expect(r.html).toContain('💵 –.--');
  });

  it('detail: unknown maxContext (=0) drops "(... ctx)" suffix from title line', () => {
    const r = renderTelegramDetail({ ...baseState(), modelMaxContext: 0 });
    expect(r.html).not.toContain('ctx');
    expect(r.html).toContain('claude-opus-4-7');  // model name still present
  });

  it('detail: unknown maxContext shows "📊 X tokens" instead of "% bar"', () => {
    const r = renderTelegramDetail({
      ...baseState(),
      modelMaxContext: 0,
      contextUsedTok: 28_400,
    });
    expect(r.html).toContain('📊 28.4k tokens');
    expect(r.html).not.toContain('%');
  });

  it('detail: 0 contextUsedTok AND unknown maxContext omits the context segment entirely', () => {
    const r = renderTelegramDetail({
      ...baseState(),
      modelMaxContext: 0,
      contextUsedTok: 0,
      costSession: 0,  // also no cost so nothing on line 3
    });
    // Title (L1) and branch (L2) still present, but no L3
    expect(r.html).toContain('💬');
    expect(r.html).toContain('🌳');
    expect(r.html).not.toContain('📊');
    expect(r.html).not.toContain('Σ');
  });

  it('detail: costSession 0 suppresses "Σ $0.00"', () => {
    const r = renderTelegramDetail({ ...baseState(), costSession: 0 });
    expect(r.html).not.toContain('Σ');
  });
});
