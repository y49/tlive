// src/kernel/session/context.ts

export interface SessionContextSnapshot {
  /** Stable tlive ID, persists across daemon restart. */
  tliveSessionId: string;
  /** Provider's own session id (Claude SDK or Codex thread). Maps to jsonl filename for Claude. */
  providerSessionId: string;
  workspaceDir: string;
  provider: string;
  createdAt: number;
}
