import { describe, it, expect } from 'vitest';
import { initialHudState, resolveModelLabel } from '../../../src/im/hud/state.js';

describe('HudState — initialHudState', () => {
  it('produces a frozen-ready snapshot with sane defaults', () => {
    const s = initialHudState({
      sessionShortId: '8cdfcfb',
      workspaceName: 'tlive',
      gitBranch: 'feat/v1.0-architecture*',
      provider: 'claude',
      model: 'opus-4-6',
      modelMaxContext: 200_000,
      turnNumber: 5,
      startedAtMs: 1_700_000_000_000,
      costSession: 0.32,
    });
    expect(s.sessionShortId).toBe('8cdfcfb');
    expect(s.workspaceName).toBe('tlive');
    expect(s.gitBranch).toBe('feat/v1.0-architecture*');
    expect(s.provider).toBe('claude');
    expect(s.model).toBe('opus-4-6');
    expect(s.turnNumber).toBe(5);
    expect(s.contextUsedTok).toBe(0);
    expect(s.currentActivity).toBeNull();
    expect(s.toolTally.size).toBe(0);
    expect(s.pendingTools.size).toBe(0);
    expect(s.subagents).toEqual([]);
    expect(s.todoList).toEqual([]);
    expect(s.quotaBars).toEqual([]);
    expect(s.costThisTurn).toBe(0);
    expect(s.costSession).toBe(0.32);
    expect(s.startedAtMs).toBe(1_700_000_000_000);
    expect(s.durationMs).toBe(0);
    expect(s.isFrozen).toBe(false);
    expect(s.isErrored).toBe(false);
    expect(s.errorSummary).toBeUndefined();
  });

  it('omitted optional fields default correctly', () => {
    const s = initialHudState({
      sessionShortId: 'abc',
      workspaceName: 'w',
      provider: 'codex',
      model: 'gpt-5',
      modelMaxContext: 128_000,
      turnNumber: 1,
      startedAtMs: 0,
      costSession: 0,
    });
    expect(s.gitBranch).toBeUndefined();
  });
});

describe('initialHudState — v2 fields', () => {
  it('askPending 默认 false,tokensTotal 默认 undefined', () => {
    const s = initialHudState({
      sessionShortId: 'a', workspaceName: 'w', provider: 'claude',
      model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
      startedAtMs: 0, costSession: 0,
    });
    expect(s.askPending).toBe(false);
    expect(s.tokensTotal).toBeUndefined();
  });
});

describe('resolveModelLabel — v2 fallback chain', () => {
  it('preferred: system frame → workspace → session → default', () => {
    expect(resolveModelLabel('opus-4-6', 'sonnet', 'haiku')).toBe('opus-4-6');
    expect(resolveModelLabel(null, 'sonnet', 'haiku')).toBe('sonnet');
    expect(resolveModelLabel(undefined, '', 'haiku')).toBe('haiku');
    expect(resolveModelLabel(null, null, null)).toBe('claude-sonnet-4');
  });
  it('whitespace-only treated as missing', () => {
    expect(resolveModelLabel('  ', null, null)).toBe('claude-sonnet-4');
  });
});
