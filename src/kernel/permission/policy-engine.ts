// src/kernel/permission/policy-engine.ts
//
// Vendor-neutral permission policy. Pure function: decides allow vs ask from a
// NORMALIZED request + in-memory state. NEVER auto-denies (deny is always a
// human action). Default is all-ask; auto-allow only for read-only tools, an
// explicit trust switch, or `safe` auto-approve. MUST NOT reference any
// CC/Codex-specific field or path.

import { isDangerous } from './risk.js';

/** How much auto-approves without a card:
 *  - 'readonly' (default): only read-only tools. Everything else asks.
 *  - 'safe': also auto-allow non-dangerous, non-MCP built-in tools; dangerous
 *    ops (risk.ts), MCP/unknown tools, and AskUserQuestion still ask. This only
 *    changes anything when there is no local dialog to answer at — with a local
 *    dialog present, grace already lets a fast keyboard answer suppress the card.
 *  The danger floor (isDangerous) is never crossed by `safe`; only the explicit
 *  `trustUntilRevoked` switch auto-allows dangerous ops. */
export type AutoApprove = 'readonly' | 'safe';

export interface PolicyState {
  /** Manual "trust switch": while true, everything auto-allows until revoked. */
  trustUntilRevoked: boolean;
  /** Per-tool "always allow" grants (e.g. 总是允许 Edit). In-memory, cleared on
   *  restart — a finer notch than the trust switch. Never auto-denies. */
  allowTools?: Set<string>;
  /** Auto-approve level; defaults to 'readonly' when absent. */
  autoApprove?: AutoApprove;
}

export interface PolicyRequest {
  toolName: string;
  /** Normalized tool input — needed by `safe` to check the danger floor. */
  input?: unknown;
  permissionMode?: string;
}

export interface PolicyDecision {
  decision: 'allow' | 'ask';
  reason?: string;
}

/** Read-only built-in tools. Empirically CC/Codex don't prompt for these in
 *  default mode; tlive's `*` hook matcher would otherwise add friction. */
// AskUserQuestion 不再 auto-allow:它现在有自己的远程卡(ask-renderer),
// 用户可以在 IM 上直接回答(deny+message wire)。
export const READ_ONLY_TOOLS = new Set<string>(['Read', 'Glob', 'Grep']);

/** MCP tools carry unknown risk (external servers) → never auto-allowed by
 *  `safe`; they must ask. */
const isMcpTool = (name: string): boolean => name.startsWith('mcp__');

export function decide(req: PolicyRequest, state: PolicyState): PolicyDecision {
  if (state.trustUntilRevoked) return { decision: 'allow', reason: 'trust-switch' };
  if (state.allowTools?.has(req.toolName)) return { decision: 'allow', reason: 'always-tool' };
  if (READ_ONLY_TOOLS.has(req.toolName)) return { decision: 'allow', reason: 'read-only' };
  if (state.autoApprove === 'safe') {
    // The floor: dangerous ops, MCP/unknown tools, and AskUserQuestion (its own
    // remote card) always ask — `safe` never lowers this.
    if (
      req.toolName !== 'AskUserQuestion' &&
      !isMcpTool(req.toolName) &&
      !isDangerous(req.toolName, req.input)
    ) {
      return { decision: 'allow', reason: 'safe' };
    }
  }
  return { decision: 'ask' };
}
