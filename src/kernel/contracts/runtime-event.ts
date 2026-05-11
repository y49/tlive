// src/kernel/contracts/runtime-event.ts
//
// FROZEN SURFACE — DO NOT MODIFY without bumping major version.

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd: number;
}

export type RuntimeEvent =
  | { kind: 'text_delta'; delta: string }
  | { kind: 'thinking_delta'; delta: string }
  | { kind: 'tool_use_start'; toolName: string; input: unknown; toolUseId: string }
  | { kind: 'tool_use_result'; toolUseId: string; output: unknown; isError: boolean }
  | { kind: 'permission_request'; toolName: string; input: unknown; requestId: string }
  | { kind: 'turn_start' }
  | { kind: 'turn_end'; usage?: Usage }
  | { kind: 'session_ready'; providerSessionId: string }
  | { kind: 'error'; message: string; recoverable: boolean };
