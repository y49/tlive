// src/session/status.ts
//
// AgentStatus state machine. T3 will add the `transition(prev, event): AgentStatus`
// pure function; T2 only defines the type so NotificationEvent can reference it.

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
