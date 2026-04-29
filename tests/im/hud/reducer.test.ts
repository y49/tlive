import { describe, it, expect } from 'vitest';
import { applyEventToHudState } from '../../../src/im/hud/reducer.js';
import { initialHudState } from '../../../src/im/hud/state.js';
import type { NotificationEvent } from '../../../src/runtime/events.js';

function base() {
  return initialHudState({
    sessionShortId: 'abc',
    workspaceName: 'w',
    provider: 'claude',
    model: 'opus-4-6',
    modelMaxContext: 200_000,
    turnNumber: 1,
    startedAtMs: 0,
    costSession: 0,
  });
}

describe('applyEventToHudState', () => {
  it('turn_start sets currentActivity to thinking', () => {
    const ev: NotificationEvent = { kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 0 };
    const next = applyEventToHudState(base(), ev);
    expect(next.currentActivity).toEqual({ kind: 'thinking', elapsedMs: 0 });
  });

  it('tool_use_start sets currentActivity with tool name + arg preview', () => {
    const ev: NotificationEvent = {
      kind: 'tool_use_start',
      turnId: 't1',
      toolUseId: 'u1',
      toolName: 'Read',
      input: { file_path: '/abs/path/README.md' },
    };
    const next = applyEventToHudState(base(), ev);
    expect(next.currentActivity).toMatchObject({
      kind: 'tool_running',
      toolName: 'Read',
      elapsedMs: 0,
    });
    expect(next.currentActivity?.toolArg).toContain('README.md');
  });

  it('tool_use_result increments toolTally and clears matching activity', () => {
    let s = base();
    s = applyEventToHudState(s, {
      kind: 'tool_use_start',
      turnId: 't1',
      toolUseId: 'u1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    s = applyEventToHudState(s, {
      kind: 'tool_use_result',
      toolUseId: 'u1',
      output: 'a\nb',
      durationMs: 12,
      ok: true,
    });
    expect(s.toolTally.get('Bash')).toBe(1);
    // After tool result the activity drops back to thinking.
    expect(s.currentActivity).toEqual({ kind: 'thinking', elapsedMs: 0 });
  });

  it('tool_use_result aggregates same-tool count', () => {
    let s = base();
    for (let i = 0; i < 3; i++) {
      s = applyEventToHudState(s, {
        kind: 'tool_use_start', turnId: 't1', toolUseId: `u${i}`, toolName: 'Bash', input: {},
      });
      s = applyEventToHudState(s, {
        kind: 'tool_use_result', toolUseId: `u${i}`, output: '', durationMs: 1, ok: true,
      });
    }
    expect(s.toolTally.get('Bash')).toBe(3);
  });

  it('parallel tool batch: results tally each tool by toolUseId, not by current activity', () => {
    let s = base();
    s = applyEventToHudState(s, {
      kind: 'tool_use_start', turnId: 't1', toolUseId: 'u1', toolName: 'Bash', input: { command: 'a' },
    });
    s = applyEventToHudState(s, {
      kind: 'tool_use_start', turnId: 't1', toolUseId: 'u2', toolName: 'Read', input: { file_path: 'x.ts' },
    });
    s = applyEventToHudState(s, {
      kind: 'tool_use_start', turnId: 't1', toolUseId: 'u3', toolName: 'Edit', input: { file_path: 'y.ts' },
    });
    expect(s.pendingTools.size).toBe(3);

    s = applyEventToHudState(s, {
      kind: 'tool_use_result', toolUseId: 'u1', output: '', durationMs: 1, ok: true,
    });
    s = applyEventToHudState(s, {
      kind: 'tool_use_result', toolUseId: 'u2', output: '', durationMs: 1, ok: true,
    });
    s = applyEventToHudState(s, {
      kind: 'tool_use_result', toolUseId: 'u3', output: '', durationMs: 1, ok: true,
    });
    expect(s.toolTally.get('Bash')).toBe(1);
    expect(s.toolTally.get('Read')).toBe(1);
    expect(s.toolTally.get('Edit')).toBe(1);
    expect(s.pendingTools.size).toBe(0);
    // After draining all pending tools, activity drops to thinking.
    expect(s.currentActivity).toEqual({ kind: 'thinking', elapsedMs: 0 });
  });

  it('tool_use_result for unknown toolUseId tallies "unknown"', () => {
    const s = applyEventToHudState(base(), {
      kind: 'tool_use_result', toolUseId: 'never-started', output: '', durationMs: 1, ok: true,
    });
    expect(s.toolTally.get('unknown')).toBe(1);
  });

  it('subagent_start appends a running entry; subagent_stop flips status', () => {
    let s = base();
    s = applyEventToHudState(s, {
      kind: 'subagent_start',
      agentId: 'a1', parentTurnId: 't1', description: 'review pass', taskId: 'tk1',
    });
    expect(s.subagents).toHaveLength(1);
    expect(s.subagents[0]).toMatchObject({ agentId: 'a1', status: 'running' });

    s = applyEventToHudState(s, {
      kind: 'subagent_stop', agentId: 'a1', taskId: 'tk1', ok: true,
    });
    expect(s.subagents[0].status).toBe('done_ok');

    const s2 = applyEventToHudState(base(), {
      kind: 'subagent_start', agentId: 'a2', parentTurnId: 't1', description: 'x', taskId: 'tk2',
    });
    const s3 = applyEventToHudState(s2, {
      kind: 'subagent_stop', agentId: 'a2', taskId: 'tk2', ok: false,
    });
    expect(s3.subagents[0].status).toBe('done_err');
  });

  it('subagent_progress sets summary on the matching subagent', () => {
    let s = applyEventToHudState(base(), {
      kind: 'subagent_start',
      agentId: 'a1', parentTurnId: 't1', description: 'review pass', taskId: 'tk1',
    });
    s = applyEventToHudState(s, {
      kind: 'subagent_progress', agentId: 'a1', summary: 'finished file scan',
    });
    expect(s.subagents[0].summary).toBe('finished file scan');
    expect(s.subagents[0].status).toBe('running');
  });

  it('subagent_progress for an unknown agentId leaves subagents unchanged', () => {
    const s0 = applyEventToHudState(base(), {
      kind: 'subagent_start',
      agentId: 'a1', parentTurnId: 't1', description: 'x', taskId: 'tk1',
    });
    const s1 = applyEventToHudState(s0, {
      kind: 'subagent_progress', agentId: 'unknown', summary: 'should not stick',
    });
    expect(s1.subagents[0].summary).toBeUndefined();
  });

  it('todo_write replaces todoList with normalized items', () => {
    const s = applyEventToHudState(base(), {
      kind: 'todo_write',
      items: [
        { content: 'design HUD', status: 'completed' },
        { content: 'write reducer', status: 'in_progress' },
        { content: 'ship', status: 'pending' },
      ],
    });
    expect(s.todoList).toEqual([
      { text: 'design HUD', status: 'done' },
      { text: 'write reducer', status: 'in_progress' },
      { text: 'ship', status: 'pending' },
    ]);
  });

  it('turn_end freezes, captures cost + duration', () => {
    const s = applyEventToHudState(base(), {
      kind: 'turn_end', turnId: 't1', durationMs: 4_200, costUsd: 0.04, tokensIn: 100, tokensOut: 50,
    });
    expect(s.isFrozen).toBe(true);
    expect(s.costThisTurn).toBe(0.04);
    expect(s.costSession).toBeCloseTo(0.04);
    expect(s.durationMs).toBe(4_200);
    expect(s.currentActivity).toBeNull();
  });

  it('runtime_error fatal sets isErrored + errorSummary', () => {
    const s = applyEventToHudState(base(), {
      kind: 'runtime_error', severity: 'fatal', code: 'sdk_aborted', message: 'connection reset',
    });
    expect(s.isErrored).toBe(true);
    expect(s.errorSummary).toBe('connection reset');
  });

  it('runtime_error warn does not flip isErrored', () => {
    const s = applyEventToHudState(base(), {
      kind: 'runtime_error', severity: 'warn', code: 'soft', message: 'ignore',
    });
    expect(s.isErrored).toBe(false);
  });

  it('quota_update replaces quotaBars with the event payload', () => {
    const s = applyEventToHudState(base(), {
      kind: 'quota_update',
      quotaBars: [
        { label: 'Usage', pct: 67, resetsIn: '2h 52m' },
        { label: 'Weekly', pct: 44 },
      ],
    });
    expect(s.quotaBars).toEqual([
      { label: 'Usage', pct: 67, resetsIn: '2h 52m' },
      { label: 'Weekly', pct: 44 },
    ]);
  });

  it('quota_update with empty array clears quotaBars', () => {
    let s = applyEventToHudState(base(), {
      kind: 'quota_update',
      quotaBars: [{ label: 'Usage', pct: 50 }],
    });
    s = applyEventToHudState(s, { kind: 'quota_update', quotaBars: [] });
    expect(s.quotaBars).toEqual([]);
  });

  it('returns same reference for unknown / no-op events', () => {
    const s0 = base();
    const s1 = applyEventToHudState(s0, { kind: 'heartbeat', elapsedMs: 100 });
    expect(s1).toBe(s0);
  });
});
