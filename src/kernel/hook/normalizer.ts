export type HookEventName =
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'stop'
  | 'notification'
  | 'user-prompt-submit'
  | 'session-start'
  | 'session-end'
  | 'post-tool-use-failure'
  | 'stop-failure'
  | 'subagent-start'
  | 'subagent-stop'
  | 'permission-request'
  | 'permission-denied';

export type HookVendor = 'claude' | 'codex';

export type NormalizedHook =
  | { event: 'approval-request'; cwd: string; sessionId: string; toolName: string; input: unknown; permissionMode?: string }
  | { event: 'activity'; cwd: string; sessionId: string; toolName: string; result: unknown }
  | { event: 'attention'; cwd: string; sessionId: string; message: string; lastMessage?: string }
  | { event: 'prompt'; cwd: string; sessionId: string; prompt: string }
  | { event: 'subagent'; cwd: string; sessionId: string; delta: 1 | -1; agentType?: string }
  | { event: 'session-start'; cwd: string; sessionId: string; source?: string }
  | { event: 'session-end'; cwd: string; sessionId: string; reason?: string }
  | { event: 'permission-denied'; cwd: string; sessionId: string; toolName: string };

/** Vendor-neutral monitoring subset carried over IPC `hook.event`. */
export type MonitorEvent = Extract<NormalizedHook, { event: 'activity' | 'attention' | 'prompt' | 'subagent' | 'session-start' | 'session-end' | 'permission-denied' }>;

interface RawHook {
  cwd?: string; session_id?: string; permission_mode?: string;
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; message?: string;
  prompt?: string; source?: string; reason?: string; last_assistant_message?: string;
  notification_type?: string;
  tool_error?: unknown;
  error_type?: string;
  agent_type?: string;
}

export function parseHookInput(event: HookEventName, raw: unknown): NormalizedHook {
  const r = (raw ?? {}) as RawHook;
  const cwd = r.cwd ?? process.cwd();
  const sessionId = r.session_id ?? '';
  switch (event) {
    case 'pre-tool-use':
    case 'permission-request':
      return { event: 'approval-request', cwd, sessionId, toolName: r.tool_name ?? '(unknown)', input: r.tool_input ?? {}, permissionMode: r.permission_mode };
    case 'permission-denied':
      return { event: 'permission-denied', cwd, sessionId, toolName: r.tool_name ?? '(unknown)' };
    case 'post-tool-use':
      return { event: 'activity', cwd, sessionId, toolName: r.tool_name ?? '(unknown)', result: r.tool_response ?? {} };
    case 'stop':
      return { event: 'attention', cwd, sessionId, message: '已完成,回复以续跑', ...(r.last_assistant_message ? { lastMessage: r.last_assistant_message } : {}) };
    case 'notification':
      // permission_prompt notifications are dropped in the shim (the parallel
      // PermissionRequest card already covers that moment); everything else
      // passes through verbatim.
      return { event: 'attention', cwd, sessionId, message: r.message ?? '需要你处理' };
    case 'user-prompt-submit':
      return { event: 'prompt', cwd, sessionId, prompt: r.prompt ?? '' };
    case 'session-start':
      return { event: 'session-start', cwd, sessionId, ...(r.source ? { source: r.source } : {}) };
    case 'session-end':
      return { event: 'session-end', cwd, sessionId, ...(r.reason ? { reason: r.reason } : {}) };
    case 'post-tool-use-failure': {
      const err = typeof r.tool_error === 'string' ? r.tool_error : JSON.stringify(r.tool_error ?? '');
      return { event: 'attention', cwd, sessionId, message: `❌ ${r.tool_name ?? '(unknown)'} 失败: ${err.slice(0, 200)}` };
    }
    case 'stop-failure':
      return { event: 'attention', cwd, sessionId, message: `❌ 会话出错: ${r.error_type ?? 'unknown'}` };
    case 'subagent-start':
      return { event: 'subagent', cwd, sessionId, delta: 1, ...(r.agent_type ? { agentType: r.agent_type } : {}) };
    case 'subagent-stop':
      return { event: 'subagent', cwd, sessionId, delta: -1, ...(r.agent_type ? { agentType: r.agent_type } : {}) };
  }
}

export function permissionDecisionOut(
  decision: 'allow' | 'deny' | 'defer',
  vendor: HookVendor = 'claude',
  reason?: string,
): object {
  if (decision === 'allow' || decision === 'deny') {
    const out: Record<string, unknown> = { hookEventName: 'PreToolUse', permissionDecision: decision };
    // Codex 对空 reason 的 deny 回落放行 → 一律附非空 reason(CC 不需要,保持原输出)。
    if (decision === 'deny' && vendor === 'codex') {
      out.permissionDecisionReason = reason && reason.trim() ? reason : '已被 tlive 拒绝';
    }
    return { hookSpecificOutput: out };
  }
  // defer 或任何非预期值 → 绝不 auto-allow:CC 空输出(回落本地 TUI),
  // Codex 输出 'ask'(原生审批提示,因 Codex 空输出=fail-open 自动跑)。
  return vendor === 'codex'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }
    : {};
}

/** PermissionRequest decision wire — identical for BOTH vendors (CC 2.1.206
 *  真机验证 allow/deny±message;Codex 0.144 源码 schema.rs
 *  PermissionRequestDecisionWire 同形,deny 缺 message 时 Codex 自动补默认
 *  理由,不像 PreToolUse 那样回落放行)。
 *  CC: 与本地对话并行,先答先得;{} = 留给用户。
 *  Codex: 串行(hook 返回 None 后才弹原生提示);{} / 超时 / 报错 → 原生
 *  审批流,结构性 fail-safe —— 不再有 PreToolUse 的 fail-open 问题。
 *  绝不 auto-allow / auto-deny。别发 updatedInput/updatedPermissions/
 *  interrupt(Codex 对这些 fail-closed)。 */
export function permissionRequestDecisionOut(decision: 'allow' | 'deny' | 'defer', reason?: string): object {
  if (decision === 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  }
  if (decision === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: reason && reason.trim() ? reason : 'Denied via tlive' },
      },
    };
  }
  return {};
}

export function continueDecisionOut(reply: string | null): object {
  return reply ? { decision: 'block', reason: reply } : {};
}

/** session-start 欢迎提示:CC-only(Codex 输出 schema deny_unknown_fields,恒 '{}'),
 *  仅在 IM 未配置时通过 additionalContext 引导 agent 主动提示用户配置。 */
export function sessionStartOut(vendor: HookVendor, imConfigured: boolean): string {
  if (vendor !== 'claude' || imConfigured) return '{}';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'tlive 已就绪(hook 审批/监看已挂载),但 IM 通知还没配置 — 用户说"帮我配置 tlive"或运行 /tlive:setup 即可由你引导完成。',
    },
  });
}
