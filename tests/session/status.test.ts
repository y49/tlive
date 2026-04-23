// tests/session/status.test.ts
//
// Exhaustive state-machine coverage of `transition(prev, event): AgentStatus`.
// Each assertion validates a single (prev phase × event kind) → next phase
// pair. Target: 40+ assertions per plan step 2.

import { describe, it, expect } from 'vitest';
import { transition, type AgentStatus } from '../../src/session/status.js';
import type { NotificationEvent } from '../../src/runtime/events.js';

const INIT: AgentStatus = { phase: 'initializing' };
const IDLE: AgentStatus = { phase: 'idle', queuedInputs: 0 };
const IDLE_Q3: AgentStatus = { phase: 'idle', queuedInputs: 3 };
const THINKING: AgentStatus = { phase: 'thinking', turnStartedAt: 1, queuedInputs: 2, subagents: 1 };
const AWAIT_PERM: AgentStatus = { phase: 'awaiting_permission', requestId: 'p1', queuedInputs: 1 };
const AWAIT_Q: AgentStatus = { phase: 'awaiting_question', requestId: 'q1' };
const AWAIT_ELICIT: AgentStatus = { phase: 'awaiting_elicitation', requestId: 'e1' };
const ERRORED: AgentStatus = { phase: 'errored', code: 'bad', message: 'x' };
const STOPPED: AgentStatus = { phase: 'stopped' };

const turnStart: NotificationEvent = { kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 100 };
const turnEnd: NotificationEvent = { kind: 'turn_end', turnId: 't1', durationMs: 10, costUsd: 0.01, tokensIn: 5, tokensOut: 5 };
const permReq: NotificationEvent = { kind: 'permission_requested', requestId: 'p1', category: 'exec', toolName: 'Bash', toolInput: {} };
const permRes: NotificationEvent = { kind: 'permission_resolved', requestId: 'p1', decision: 'allow' };
const askReq: NotificationEvent = { kind: 'ask_user_question_requested', requestId: 'q1', prompt: 'pick', options: ['a', 'b'] };
const askRes: NotificationEvent = { kind: 'ask_user_question_resolved', requestId: 'q1', chosen: ['a'] };
const elicitReq: NotificationEvent = { kind: 'elicitation_requested', requestId: 'e1', mcpServerName: 'foo' };
const elicitRes: NotificationEvent = { kind: 'elicitation_resolved', requestId: 'e1', action: 'accept' };
const rtErr: NotificationEvent = { kind: 'runtime_error', severity: 'warn', code: 'X', message: 'boom' };
const throttle: NotificationEvent = { kind: 'api_throttle', retryAfterMs: 5000, message: 'throttled' };
const resumed: NotificationEvent = { kind: 'api_resumed' };
const complete: NotificationEvent = { kind: 'session_complete', reason: 'ok', summary: 's' };
const heartbeat: NotificationEvent = { kind: 'heartbeat', elapsedMs: 1 };
const subStart: NotificationEvent = { kind: 'subagent_start', agentId: 'a1', parentTurnId: 't1', description: 'd', taskId: 'task1' };
const subStop: NotificationEvent = { kind: 'subagent_stop', agentId: 'a1', taskId: 'task1', ok: true };
const toolStart: NotificationEvent = { kind: 'tool_use_start', turnId: 't1', toolUseId: 'tu1', toolName: 'Bash', input: {} };
const toolRes: NotificationEvent = { kind: 'tool_use_result', toolUseId: 'tu1', output: {}, durationMs: 10, ok: true };
const cacheWarm: NotificationEvent = { kind: 'cache_warmth_change', warmUntilMs: 1234 };

describe('transition(prev, event) — full table', () => {
  // --- turn_start: any non-stopped → thinking ---------
  it('initializing + turn_start → thinking', () => {
    const r = transition(INIT, turnStart);
    expect(r.phase).toBe('thinking');
  });
  it('idle + turn_start → thinking (queue preserved)', () => {
    const r = transition(IDLE_Q3, turnStart);
    expect(r.phase).toBe('thinking');
    if (r.phase === 'thinking') expect(r.queuedInputs).toBe(3);
  });
  it('thinking + turn_start → thinking (subagents + queue preserved)', () => {
    const r = transition(THINKING, turnStart);
    expect(r.phase).toBe('thinking');
    if (r.phase === 'thinking') { expect(r.subagents).toBe(1); expect(r.queuedInputs).toBe(2); }
  });
  it('stopped + turn_start → stopped (terminal)', () => {
    expect(transition(STOPPED, turnStart).phase).toBe('stopped');
  });

  // --- turn_end: thinking → idle ---------
  it('thinking + turn_end → idle (queue preserved)', () => {
    const r = transition(THINKING, turnEnd);
    expect(r.phase).toBe('idle');
    if (r.phase === 'idle') expect(r.queuedInputs).toBe(2);
  });
  it('idle + turn_end → idle (queue preserved)', () => {
    const r = transition(IDLE_Q3, turnEnd);
    expect(r.phase).toBe('idle');
    if (r.phase === 'idle') expect(r.queuedInputs).toBe(3);
  });

  // --- permission lifecycle ---------
  it('thinking + permission_requested → awaiting_permission', () => {
    const r = transition(THINKING, permReq);
    expect(r.phase).toBe('awaiting_permission');
    if (r.phase === 'awaiting_permission') expect(r.requestId).toBe('p1');
  });
  it('awaiting_permission + permission_resolved → thinking', () => {
    const r = transition(AWAIT_PERM, permRes);
    expect(r.phase).toBe('thinking');
    if (r.phase === 'thinking') expect(r.queuedInputs).toBe(1);
  });
  it('idle + permission_resolved → idle (no-op, only valid from awaiting_permission)', () => {
    expect(transition(IDLE, permRes)).toBe(IDLE);
  });

  // --- ask_user_question ---------
  it('thinking + ask_user_question_requested → awaiting_question', () => {
    expect(transition(THINKING, askReq).phase).toBe('awaiting_question');
  });
  it('awaiting_question + ask_user_question_resolved → thinking', () => {
    expect(transition(AWAIT_Q, askRes).phase).toBe('thinking');
  });
  it('idle + ask_user_question_resolved → idle (no-op)', () => {
    expect(transition(IDLE, askRes)).toBe(IDLE);
  });

  // --- elicitation ---------
  it('thinking + elicitation_requested → awaiting_elicitation', () => {
    expect(transition(THINKING, elicitReq).phase).toBe('awaiting_elicitation');
  });
  it('awaiting_elicitation + elicitation_resolved → thinking', () => {
    expect(transition(AWAIT_ELICIT, elicitRes).phase).toBe('thinking');
  });
  it('idle + elicitation_resolved → idle (no-op)', () => {
    expect(transition(IDLE, elicitRes)).toBe(IDLE);
  });

  // --- runtime_error → errored ---------
  it('thinking + runtime_error → errored', () => {
    const r = transition(THINKING, rtErr);
    expect(r.phase).toBe('errored');
    if (r.phase === 'errored') expect(r.code).toBe('X');
  });
  it('idle + runtime_error → errored', () => {
    expect(transition(IDLE, rtErr).phase).toBe('errored');
  });
  it('awaiting_permission + runtime_error → errored', () => {
    expect(transition(AWAIT_PERM, rtErr).phase).toBe('errored');
  });

  // --- throttle/resume ---------
  it('thinking + api_throttle → errored(api_throttled)', () => {
    const r = transition(THINKING, throttle);
    expect(r.phase).toBe('errored');
    if (r.phase === 'errored') expect(r.code).toBe('api_throttled');
  });
  it('errored + api_resumed → idle', () => {
    expect(transition(ERRORED, resumed).phase).toBe('idle');
  });

  // --- session_complete ---------
  it('thinking + session_complete → idle', () => {
    expect(transition(THINKING, complete).phase).toBe('idle');
  });
  it('stopped + session_complete → stopped (terminal guard)', () => {
    expect(transition(STOPPED, complete).phase).toBe('stopped');
  });

  // --- subagents ---------
  it('thinking + subagent_start increments subagents', () => {
    const r = transition(THINKING, subStart);
    if (r.phase === 'thinking') expect(r.subagents).toBe(2);
    else throw new Error('expected thinking');
  });
  it('thinking + subagent_stop decrements subagents', () => {
    const r = transition(THINKING, subStop);
    if (r.phase === 'thinking') expect(r.subagents).toBe(0);
    else throw new Error('expected thinking');
  });
  it('idle + subagent_start → idle (no-op, not in a turn)', () => {
    expect(transition(IDLE, subStart)).toBe(IDLE);
  });
  it('thinking + subagent_stop clamps at 0', () => {
    const base: AgentStatus = { phase: 'thinking', turnStartedAt: 1, queuedInputs: 0, subagents: 0 };
    const r = transition(base, subStop);
    if (r.phase === 'thinking') expect(r.subagents).toBe(0);
    else throw new Error('expected thinking');
  });

  // --- tool tracking ---------
  it('thinking + tool_use_start sets currentTool', () => {
    const r = transition(THINKING, toolStart);
    if (r.phase === 'thinking') expect(r.currentTool).toBe('Bash');
    else throw new Error('expected thinking');
  });
  it('thinking + tool_use_result clears currentTool', () => {
    const base: AgentStatus = { phase: 'thinking', turnStartedAt: 1, queuedInputs: 0, subagents: 0, currentTool: 'Bash' };
    const r = transition(base, toolRes);
    if (r.phase === 'thinking') expect(r.currentTool).toBeUndefined();
    else throw new Error('expected thinking');
  });
  it('idle + tool_use_start → idle (no-op)', () => {
    expect(transition(IDLE, toolStart)).toBe(IDLE);
  });

  // --- cache_warmth_change ---------
  it('idle + cache_warmth_change stores warmUntilMs', () => {
    const r = transition(IDLE, cacheWarm);
    if (r.phase === 'idle') expect(r.cacheWarmUntilMs).toBe(1234);
    else throw new Error('expected idle');
  });
  it('idle + cache_warmth_change(null) clears warmUntilMs', () => {
    const r = transition(IDLE, { kind: 'cache_warmth_change', warmUntilMs: null });
    if (r.phase === 'idle') expect(r.cacheWarmUntilMs).toBeUndefined();
    else throw new Error('expected idle');
  });
  it('thinking + cache_warmth_change → thinking (no-op)', () => {
    expect(transition(THINKING, cacheWarm)).toBe(THINKING);
  });

  // --- heartbeat/unknown → passthrough ---------
  it('idle + heartbeat → idle (no-op)', () => {
    expect(transition(IDLE, heartbeat)).toBe(IDLE);
  });
  it('thinking + heartbeat → thinking (no-op)', () => {
    expect(transition(THINKING, heartbeat)).toBe(THINKING);
  });

  // --- terminal guard ---------
  it('stopped + permission_requested → stopped', () => {
    expect(transition(STOPPED, permReq).phase).toBe('stopped');
  });
  it('stopped + runtime_error → stopped', () => {
    expect(transition(STOPPED, rtErr).phase).toBe('stopped');
  });
  it('stopped + heartbeat → stopped', () => {
    expect(transition(STOPPED, heartbeat).phase).toBe('stopped');
  });
  it('stopped + session_complete → stopped', () => {
    expect(transition(STOPPED, complete).phase).toBe('stopped');
  });

  // --- idempotent: same input returns stable shape ---------
  it('permission_requested preserves queue count from idle', () => {
    const r = transition(IDLE_Q3, permReq);
    if (r.phase === 'awaiting_permission') expect(r.queuedInputs).toBe(3);
    else throw new Error('expected awaiting_permission');
  });
  it('turn_start from awaiting_permission → thinking (not a strict rule but covered)', () => {
    const r = transition(AWAIT_PERM, turnStart);
    expect(r.phase).toBe('thinking');
  });
  it('turn_end from awaiting_permission → idle (queue preserved)', () => {
    const r = transition(AWAIT_PERM, turnEnd);
    if (r.phase === 'idle') expect(r.queuedInputs).toBe(1);
    else throw new Error('expected idle');
  });
});
