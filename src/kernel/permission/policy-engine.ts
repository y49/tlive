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
  /** Auto-approve level. Absent = off: nothing is auto-allowed, so tlive never
   *  removes a dialog CC meant to show (see READ_ONLY_TOOLS). */
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

/** Read-only built-in tools — auto-allowed only under an explicit `autoApprove`.
 *
 *  This list used to be allowed unconditionally, on the theory that "CC doesn't
 *  prompt for these anyway, and tlive's `*` matcher would add friction". That
 *  theory is wrong: PermissionRequest fires ONLY when CC is about to show a
 *  permission dialog (docs: "Runs when the user is shown a permission dialog"),
 *  so the hook never sees an ungated Read — the `*` matcher adds no friction to
 *  suppress. Every allow here therefore *deletes* a dialog the user would have
 *  seen (e.g. a Read outside the working directory), which breaks the baseline
 *  contract that installing tlive must not change what CC asks about. */
// AskUserQuestion 不再 auto-allow:它现在有自己的远程卡(ask-renderer),
// 用户可以在 IM 上直接回答(deny+message wire)。
export const READ_ONLY_TOOLS = new Set<string>(['Read', 'Glob', 'Grep']);

/** MCP tools carry unknown risk (external servers) → never auto-allowed by
 *  `safe`; they must ask. */
const isMcpTool = (name: string): boolean => name.startsWith('mcp__');

/** The one wording for the `safe` runtime toggle, shared by the CLI
 *  (`tlive safe on|off`) and the IM `/safe on|off` — they flip the same daemon
 *  state, so two hand-written copies would eventually describe it differently.
 *  `off` reverts to whatever `approvals.autoApprove` asked for, which is nothing
 *  unless the user set it, hence no promise of a read-only exception here. */
export const SAFE_TOGGLE_MESSAGE = {
  on: 'Safe auto-approve ON — routine ops run without a card; dangerous ops, MCP/unknown tools, and questions still ask.',
  off: 'Safe auto-approve OFF — back to asking for everything (read-only tools skip the card only if approvals.autoApprove is set).',
} as const;

export function decide(req: PolicyRequest, state: PolicyState): PolicyDecision {
  if (state.trustUntilRevoked) return { decision: 'allow', reason: 'trust-switch' };
  if (state.allowTools?.has(req.toolName)) return { decision: 'allow', reason: 'always-tool' };
  if (state.autoApprove !== undefined && READ_ONLY_TOOLS.has(req.toolName)) {
    return { decision: 'allow', reason: 'read-only' };
  }
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
