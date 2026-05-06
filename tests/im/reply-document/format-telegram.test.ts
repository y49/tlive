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

describe('renderTelegramDetail — v3.2.3 <blockquote> card with inline styles', () => {
  it('wraps content in <blockquote>...</blockquote>', () => {
    const r = renderTelegramDetail(baseState());
    expect(r.html.startsWith('<blockquote>')).toBe(true);
    expect(r.html.endsWith('</blockquote>')).toBe(true);
  });
  it('line 1 — 💬 <b>#N</b> · <code>sid</code> + <i>model · maxK</i>', () => {
    const r = renderTelegramDetail(baseState());
    expect(r.html).toContain('💬 <b>#5</b>');
    expect(r.html).toContain('<code>8cdfcfb</code>');
    expect(r.html).toContain('<i>claude-opus-4-7 · 200.0k</i>');
  });
  it('line 2 — 🌳 <code>branch</code> · <i>workspace</i>, omitted if no branch', () => {
    const withBranch = renderTelegramDetail(baseState());
    expect(withBranch.html).toContain('🌳 <code>feat/v1.0</code> · <i>tlive</i>');

    const noBranch = renderTelegramDetail({ ...baseState(), gitBranch: undefined });
    expect(noBranch.html).not.toContain('🌳');
  });
  it('line 3 — 📊 <b>%</b> + 💰 <b>$X.XX</b>', () => {
    const r = renderTelegramDetail(baseState({
      contextUsedTok: 44_200,
      costSession: 0.25,
    }));
    expect(r.html).toContain('📊 <b>22%</b>');
    expect(r.html).toContain('<i>(44.2k/200.0k)</i>');
    expect(r.html).toContain('💰 <b>$0.25</b>');
    // No character progress bar anymore (▓░░ retired)
    expect(r.html).not.toContain('▓');
  });
  it('appends quota lines with 📈 anchor + percent + label', () => {
    const r = renderTelegramDetail(baseState({
      quotaBars: [{ label: '5h', pct: 45, resetsIn: '3h 57m' }],
    }));
    expect(r.html).toContain('📈 <b>45%</b>');
    expect(r.html).toContain('<i>5h</i>');
    expect(r.html).toContain('3h 57m');
  });
});

describe('renderTelegramDetail — inline keyboard (Task 28)', () => {
  it('returns default 4-button keyboard with new/list/stop/⋯', () => {
    const r = renderTelegramDetail(baseState());
    expect(r.replyMarkup?.type).toBe('inline_keyboard');
    const labels = (r.replyMarkup?.buttons ?? []).flat().map(b => b.text);
    expect(labels).toEqual(['🆕 new', '📋 list', '⏸ 中断', '⋯']);
  });

  it('callbackData matches spec namespace', () => {
    const r = renderTelegramDetail(baseState());
    const cbs = (r.replyMarkup?.buttons ?? []).flat().map(b => b.callbackData);
    expect(cbs).toEqual(['session:new', 'session:list', 'turn:stop', 'menu:expand']);
  });

  it('stop button degrades to ⏸ + turn:stop:idle when frozen', () => {
    const r = renderTelegramDetail(baseState({ isFrozen: true }));
    const stopBtn = (r.replyMarkup?.buttons ?? []).flat().find(b => b.text.startsWith('⏸'));
    expect(stopBtn?.text).toBe('⏸');
    expect(stopBtn?.callbackData).toBe('turn:stop:idle');
  });

  it('stop button degrades when errored', () => {
    const r = renderTelegramDetail(baseState({ isErrored: true, errorSummary: 'oops' }));
    const stopBtn = (r.replyMarkup?.buttons ?? []).flat().find(b => b.text.startsWith('⏸'));
    expect(stopBtn?.text).toBe('⏸');
    expect(stopBtn?.callbackData).toBe('turn:stop:idle');
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

  it('detail: unknown maxContext (=0) drops max-tok suffix from title line', () => {
    const r = renderTelegramDetail({ ...baseState(), modelMaxContext: 0 });
    // Title becomes: 💬 <b>#5</b> · <code>sid</code>  <i>claude-opus-4-7</i> (no max)
    expect(r.html).toContain('<i>claude-opus-4-7</i>');
    expect(r.html).not.toContain('200.0k');
  });

  it('detail: unknown maxContext shows "📊 <b>X</b> <i>tokens</i>" instead of %', () => {
    const r = renderTelegramDetail({
      ...baseState(),
      modelMaxContext: 0,
      contextUsedTok: 28_400,
    });
    expect(r.html).toContain('📊 <b>28.4k</b> <i>tokens</i>');
    expect(r.html).not.toMatch(/<b>\d+%<\/b>/);
  });

  it('detail: 0 contextUsedTok AND unknown maxContext omits the context segment entirely', () => {
    const r = renderTelegramDetail({
      ...baseState(),
      modelMaxContext: 0,
      contextUsedTok: 0,
      costSession: 0,
    });
    expect(r.html).toContain('💬');
    expect(r.html).toContain('🌳');
    expect(r.html).not.toContain('📊');
    expect(r.html).not.toContain('💰');
  });

  it('detail: costSession 0 suppresses "💰 $0.00"', () => {
    const r = renderTelegramDetail({ ...baseState(), costSession: 0 });
    expect(r.html).not.toContain('💰');
  });
});
