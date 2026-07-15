// src/kernel/permission/policy-engine.ts
//
// Vendor-neutral permission policy. Pure function: decides allow vs ask from a
// NORMALIZED request + in-memory state. NEVER auto-denies (deny is always a
// human action). Default is all-ask; auto-allow only for read-only tools or an
// explicit trust switch. MUST NOT reference any CC/Codex-specific field or path.

export interface PolicyState {
  /** Manual "trust switch": while true, everything auto-allows until revoked. */
  trustUntilRevoked: boolean;
  /** Per-tool "always allow" grants (e.g. 总是允许 Edit). In-memory, cleared on
   *  restart — a finer notch than the trust switch. Never auto-denies. */
  allowTools?: Set<string>;
}

export interface PolicyRequest {
  toolName: string;
  permissionMode?: string;
}

export interface PolicyDecision {
  decision: 'allow' | 'ask';
  reason?: string;
}

/** Read-only built-in tools. Empirically CC/Codex don't prompt for these in
 *  default mode; tlive's `*` hook matcher would otherwise add friction. */
// AskUserQuestion:交互 UI 工具,零破坏性;CC 会为它 fire PermissionRequest,
// 但远程"允许"只是让问题在终端弹出,问题本身必须在终端答 —— 发卡纯属噪音。
export const READ_ONLY_TOOLS = new Set<string>(['Read', 'Glob', 'Grep', 'AskUserQuestion']);

export function decide(req: PolicyRequest, state: PolicyState): PolicyDecision {
  if (state.trustUntilRevoked) return { decision: 'allow', reason: 'trust-switch' };
  if (state.allowTools?.has(req.toolName)) return { decision: 'allow', reason: 'always-tool' };
  if (READ_ONLY_TOOLS.has(req.toolName)) return { decision: 'allow', reason: 'read-only' };
  return { decision: 'ask' };
}
