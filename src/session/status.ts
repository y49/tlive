// src/session/status.ts
//
// AgentStatus state machine + pure `transition(prev, event): AgentStatus`
// consumed by LocalSession / RemoteSession to keep observable status aligned
// with the NotificationEvent stream. Separated into its own file so renderers
// and any external consumer can fold events deterministically without holding
// a session instance.

import type { NotificationEvent } from '../runtime/events.js';

export type AgentStatus =
  | { phase: 'initializing' }
  | { phase: 'idle'; queuedInputs: number; cacheWarmUntilMs?: number }
  | { phase: 'thinking'; turnStartedAt: number; currentTool?: string; queuedInputs: number; subagents: number }
  | { phase: 'awaiting_permission'; requestId: string; queuedInputs: number }
  | { phase: 'awaiting_question'; requestId: string }
  | { phase: 'awaiting_elicitation'; requestId: string }
  | { phase: 'interrupted'; at: number; reason?: string }
  | { phase: 'handed_off'; at: number }
  | { phase: 'errored'; code: string; message: string; retriableAtMs?: number }
  | { phase: 'stopped' };

/**
 * Pure transition function. Unknown event kinds or combinations that aren't
 * state-changing return `prev` unchanged so callers can safely feed every
 * NotificationEvent they receive without conditional routing.
 */
export function transition(prev: AgentStatus, e: NotificationEvent): AgentStatus {
  // Terminal state — stopped sessions never transition elsewhere.
  if (prev.phase === 'stopped') return prev;

  switch (e.kind) {
    case 'turn_start':
      return {
        phase: 'thinking',
        turnStartedAt: e.at,
        queuedInputs: queuedOf(prev),
        subagents: subagentsOf(prev),
      };

    case 'turn_end':
      return { phase: 'idle', queuedInputs: queuedOf(prev) };

    case 'permission_requested':
      return {
        phase: 'awaiting_permission',
        requestId: e.requestId,
        queuedInputs: queuedOf(prev),
      };

    case 'permission_resolved':
      if (prev.phase !== 'awaiting_permission') return prev;
      return {
        phase: 'thinking',
        turnStartedAt: Date.now(),
        queuedInputs: prev.queuedInputs,
        subagents: 0,
      };

    case 'ask_user_question_requested':
      return { phase: 'awaiting_question', requestId: e.requestId };

    case 'ask_user_question_resolved':
      if (prev.phase !== 'awaiting_question') return prev;
      return {
        phase: 'thinking',
        turnStartedAt: Date.now(),
        queuedInputs: queuedOf(prev),
        subagents: 0,
      };

    case 'elicitation_requested':
      return { phase: 'awaiting_elicitation', requestId: e.requestId };

    case 'elicitation_resolved':
      if (prev.phase !== 'awaiting_elicitation') return prev;
      return {
        phase: 'thinking',
        turnStartedAt: Date.now(),
        queuedInputs: queuedOf(prev),
        subagents: 0,
      };

    case 'runtime_error':
      return {
        phase: 'errored',
        code: e.code,
        message: e.message,
        retriableAtMs: e.retryHintMs,
      };

    case 'api_throttle':
      return {
        phase: 'errored',
        code: 'api_throttled',
        message: e.message,
        retriableAtMs: e.retryAfterMs,
      };

    case 'api_resumed':
      return { phase: 'idle', queuedInputs: queuedOf(prev) };

    case 'session_complete':
      return { phase: 'idle', queuedInputs: queuedOf(prev) };

    case 'subagent_start':
      if (prev.phase !== 'thinking') return prev;
      return { ...prev, subagents: prev.subagents + 1 };

    case 'subagent_stop':
      if (prev.phase !== 'thinking') return prev;
      return { ...prev, subagents: Math.max(0, prev.subagents - 1) };

    case 'tool_use_start':
      if (prev.phase !== 'thinking') return prev;
      return { ...prev, currentTool: e.toolName };

    case 'tool_use_result':
      if (prev.phase !== 'thinking') return prev;
      return { ...prev, currentTool: undefined };

    case 'cache_warmth_change':
      if (prev.phase !== 'idle') return prev;
      return { ...prev, cacheWarmUntilMs: e.warmUntilMs ?? undefined };

    default:
      return prev;
  }
}

function queuedOf(s: AgentStatus): number {
  if (s.phase === 'idle' || s.phase === 'thinking' || s.phase === 'awaiting_permission') {
    return s.queuedInputs;
  }
  return 0;
}

function subagentsOf(s: AgentStatus): number {
  return s.phase === 'thinking' ? s.subagents : 0;
}
