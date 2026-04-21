// src/ipc-protocol.ts
//
// Strongly-typed message catalogue for daemon ↔ CLI IPC. Both sides
// import these types; keeps request/response shapes in sync.

import type { PermissionDecision } from './runtime/types.js';
import type { SessionSnapshot } from './session/persistence.js';

export type IPCRequest =
  | { type: 'create_session'; payload: { provider: 'claude' | 'codex'; workdir: string; initialPrompt?: string; workspaceId?: string; workspaceName?: string; model?: string; effort?: 'low' | 'medium' | 'high' | 'max' } }
  | { type: 'send_input'; payload: { sessionId: string; text: string } }
  | { type: 'stop_session'; payload: { sessionId: string } }
  | { type: 'resume_session'; payload: { sessionId: string } }
  | { type: 'list_sessions'; payload: Record<string, never> }
  | { type: 'resolve_permission'; payload: { sessionId: string; permissionId: string; decision: PermissionDecision } }
  | { type: 'tail_history'; payload: { sessionId: string; follow?: boolean } };

export type IPCResponse =
  | { type: 'session_created'; payload: { sessionId: string } }
  | { type: 'session_list'; payload: { sessions: SessionSnapshot[] } }
  | { type: 'ack'; payload: { ok: true } }
  | { type: 'error'; payload: { message: string } };

/** Reply correlation: caller sets requestId; daemon echoes it. */
export interface Envelope<M> {
  requestId: string;
  message: M;
}
