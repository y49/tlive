import { describe, it, expect } from 'vitest';
import { renderTelegram } from '../../../src/im/reply-document/format-telegram.js';
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

describe('renderTelegram — banner', () => {
  it('thinking 状态:◐ thinking', () => {
    const r = renderTelegram(baseState(), '');
    expect(r.html).toContain('<b>◐ thinking</b>');
  });
  it('tool_running:◐ <toolName>', () => {
    const r = renderTelegram(baseState({
      currentActivity: { kind: 'tool_running', toolName: 'Read', toolArg: 'README.md', elapsedMs: 1200 },
    }), 'body');
    expect(r.html).toContain('<b>◐ Read</b>');
  });
  it('askPending:❓ awaiting input', () => {
    const r = renderTelegram(baseState({ askPending: true }), '');
    expect(r.html).toContain('<b>❓ awaiting input</b>');
  });
  it('waiting_permission:⏸', () => {
    const r = renderTelegram(baseState({
      currentActivity: { kind: 'waiting_permission', toolName: 'Bash', elapsedMs: 0 },
    }), '');
    expect(r.html).toContain('<b>⏸ waiting for permission</b>');
  });
  it('frozen done:✓ done', () => {
    const r = renderTelegram(baseState({ isFrozen: true }), '');
    expect(r.html).toContain('<b>✓ done</b>');
  });
  it('errored:❌ error · summary', () => {
    const r = renderTelegram(baseState({ isErrored: true, errorSummary: 'oops' }), '');
    expect(r.html).toContain('<b>❌ error · oops</b>');
  });
});

describe('renderTelegram — footer (blockquote expandable)', () => {
  it('包含 turn header + context bar + cost line', () => {
    const r = renderTelegram(baseState({
      contextUsedTok: 64_000,
      toolTally: new Map([['Read', 3], ['Bash', 1]]),
      durationMs: 12_300,
      costThisTurn: 0.04,
    }), 'body');
    expect(r.html).toContain('<blockquote expandable>');
    expect(r.html).toContain('📊 turn 5');
    expect(r.html).toContain('8cdfcfb');
    expect(r.html).toContain('opus-4-6');
    expect(r.html).toContain('Context');
    expect(r.html).toContain('32%');
    expect(r.html).toContain('Read×3');
    expect(r.html).toContain('Bash×1');
    expect(r.html).toContain('12.3s');
    expect(r.html).toContain('$0.04');
    expect(r.html).toContain('Σ $0.18');
    expect(r.html).toContain('</blockquote>');
  });

  it('body 在 footer 之外,允许 fence code 不嵌套', () => {
    const r = renderTelegram(baseState(), '```ts\nconst x = 1;\n```');
    const bqStart = r.html.indexOf('<blockquote expandable>');
    const preStart = r.html.indexOf('<pre>');
    expect(preStart).toBeGreaterThan(-1);
    expect(preStart).toBeLessThan(bqStart);
  });
});
