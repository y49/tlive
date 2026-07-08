export type HookEventName =
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'stop'
  | 'notification'
  | 'user-prompt-submit'
  | 'session-start'
  | 'session-end';

export type HookVendor = 'claude' | 'codex';

export type NormalizedHook =
  | { event: 'approval-request'; cwd: string; sessionId: string; toolName: string; input: unknown; permissionMode?: string }
  | { event: 'activity'; cwd: string; sessionId: string; toolName: string; result: unknown }
  | { event: 'attention'; cwd: string; sessionId: string; message: string; lastMessage?: string }
  | { event: 'prompt'; cwd: string; sessionId: string; prompt: string }
  | { event: 'session-start'; cwd: string; sessionId: string; source?: string }
  | { event: 'session-end'; cwd: string; sessionId: string; reason?: string };

/** Vendor-neutral monitoring subset carried over IPC `hook.event`. */
export type MonitorEvent = Extract<NormalizedHook, { event: 'activity' | 'attention' | 'prompt' | 'session-start' | 'session-end' }>;

interface RawHook {
  cwd?: string; session_id?: string; permission_mode?: string;
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; message?: string;
  prompt?: string; source?: string; reason?: string; last_assistant_message?: string;
}

export function parseHookInput(event: HookEventName, raw: unknown): NormalizedHook {
  const r = (raw ?? {}) as RawHook;
  const cwd = r.cwd ?? process.cwd();
  const sessionId = r.session_id ?? '';
  switch (event) {
    case 'pre-tool-use':
      return { event: 'approval-request', cwd, sessionId, toolName: r.tool_name ?? '(unknown)', input: r.tool_input ?? {}, permissionMode: r.permission_mode };
    case 'post-tool-use':
      return { event: 'activity', cwd, sessionId, toolName: r.tool_name ?? '(unknown)', result: r.tool_response ?? {} };
    case 'stop':
      return { event: 'attention', cwd, sessionId, message: 'Claude 已完成,回复以续跑', ...(r.last_assistant_message ? { lastMessage: r.last_assistant_message } : {}) };
    case 'notification':
      return { event: 'attention', cwd, sessionId, message: r.message ?? 'Claude 需要你' };
    case 'user-prompt-submit':
      return { event: 'prompt', cwd, sessionId, prompt: r.prompt ?? '' };
    case 'session-start':
      return { event: 'session-start', cwd, sessionId, ...(r.source ? { source: r.source } : {}) };
    case 'session-end':
      return { event: 'session-end', cwd, sessionId, ...(r.reason ? { reason: r.reason } : {}) };
  }
}

export function permissionDecisionOut(
  decision: 'allow' | 'deny' | 'defer',
  vendor: HookVendor = 'claude',
  reason?: string,
): object {
  if (decision === 'defer') {
    // CC: 空输出 → 回落本地 TUI。Codex: 空输出=fail-open(命令自动跑),
    // 故输出 'ask' → Codex 原生审批提示,保持"绝不 auto-allow"。
    return vendor === 'codex'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }
      : {};
  }
  const out: Record<string, unknown> = { hookEventName: 'PreToolUse', permissionDecision: decision };
  // Codex 对空 reason 的 deny 回落为放行 → 一律附非空 reason(CC 不需要,保持原输出)。
  if (decision === 'deny' && vendor === 'codex') {
    out.permissionDecisionReason = reason && reason.trim() ? reason : '已被 tlive 拒绝';
  }
  return { hookSpecificOutput: out };
}

export function continueDecisionOut(reply: string | null): object {
  return reply ? { decision: 'block', reason: reply } : {};
}
