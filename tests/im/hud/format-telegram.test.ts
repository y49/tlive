import { describe, it, expect } from 'vitest';
import { formatTelegramHud } from '../../../src/im/hud/format-telegram.js';
import { initialHudState } from '../../../src/im/hud/state.js';

function s() {
  return initialHudState({
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
}

describe('formatTelegramHud', () => {
  it('produces a <pre><code> block with header line and unicode bars', () => {
    const out = formatTelegramHud(s());
    expect(out).toMatch(/^<pre><code>/);
    expect(out).toMatch(/<\/code><\/pre>$/);
    expect(out).toContain('turn 5');
    expect(out).toContain('8cdfcfb');
    expect(out).toContain('opus-4-6');
    expect(out).toContain('tlive');
    expect(out).toContain('feat/v1.0-architecture*');
  });

  it('renders Context bar with correct width when contextUsedTok > 0', () => {
    const state = { ...s(), contextUsedTok: 146_000 }; // 73% of 200k
    const out = formatTelegramHud(state);
    expect(out).toContain('Context');
    expect(out).toMatch(/Context\s+[▓░]+\s+73%/);
  });

  it('renders quotaBars when present', () => {
    const state = {
      ...s(),
      quotaBars: [
        { label: 'Usage', pct: 67, resetsIn: '2h 52m' },
        { label: 'Weekly', pct: 44, resetsIn: '1d 8h' },
      ],
    };
    const out = formatTelegramHud(state);
    expect(out).toMatch(/Usage\s+[▓░]+\s+67%\s+\(2h 52m\)/);
    expect(out).toMatch(/Weekly\s+[▓░]+\s+44%\s+\(1d 8h\)/);
  });

  it('renders currentActivity tool_running with elapsed', () => {
    const state = {
      ...s(),
      currentActivity: { kind: 'tool_running' as const, toolName: 'Read', toolArg: 'README.md', elapsedMs: 423 },
    };
    const out = formatTelegramHud(state);
    expect(out).toContain('Read');
    expect(out).toContain('README.md');
    expect(out).toMatch(/0\.4s|0\.5s/);
  });

  it('renders tool tally chips when toolTally non-empty', () => {
    const state = { ...s(), toolTally: new Map([['Bash', 3], ['Read', 2]]) };
    const out = formatTelegramHud(state);
    expect(out).toContain('Bash ×3');
    expect(out).toContain('Read ×2');
  });

  it('renders subagent line', () => {
    const state = {
      ...s(),
      subagents: [{ agentId: 'a1', name: 'general-purpose', model: 'sonnet', status: 'done_ok' as const, summary: 'Polish — review pass' }],
    };
    const out = formatTelegramHud(state);
    expect(out).toContain('general-purpose');
    expect(out).toContain('Polish — review pass');
  });

  it('renders cost + duration footer', () => {
    const state = { ...s(), costThisTurn: 0.04, durationMs: 4_200 };
    const out = formatTelegramHud(state);
    expect(out).toMatch(/\$0\.04/);
    expect(out).toMatch(/4\.2s/);
    expect(out).toMatch(/\$0\.32/);
  });

  it('frozen state shows ✓ done suffix in header', () => {
    const out = formatTelegramHud({ ...s(), isFrozen: true });
    expect(out).toMatch(/turn 5.*done/i);
  });

  it('errored state shows error indicator', () => {
    const out = formatTelegramHud({ ...s(), isErrored: true, errorSummary: 'API 503', isFrozen: true });
    expect(out).toContain('API 503');
  });

  it('escapes HTML in dynamic content (workspaceName + branch + tool args)', () => {
    const state = {
      ...s(),
      workspaceName: 'a<b>c',
      gitBranch: 'br&ch',
      currentActivity: { kind: 'tool_running' as const, toolName: 'Bash', toolArg: 'echo "<x>"', elapsedMs: 0 },
    };
    const out = formatTelegramHud(state);
    expect(out).toContain('a&lt;b&gt;c');
    expect(out).toContain('br&amp;ch');
    expect(out).toContain('&lt;x&gt;');
  });
});
