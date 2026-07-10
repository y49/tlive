export type HookEventName =
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'stop'
  | 'notification'
  | 'user-prompt-submit'
  | 'session-start'
  | 'session-end'
  | 'post-tool-use-failure'
  | 'stop-failure';

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
  notification_type?: string;
  tool_error?: unknown;
  error_type?: string;
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
      return { event: 'attention', cwd, sessionId, message: '已完成,回复以续跑', ...(r.last_assistant_message ? { lastMessage: r.last_assistant_message } : {}) };
    case 'notification': {
      const base = r.message ?? '需要你处理';
      // permission_prompt = 本地权限对话已弹出(tlive 已 defer / 未接管)——
      // 这是离屏用户的盲区时刻,IM 提示"去终端"。其余类型原样透传。
      const message = r.notification_type === 'permission_prompt'
        ? `⏳ 终端正在等待你的审批:${base}`
        : base;
      return { event: 'attention', cwd, sessionId, message };
    }
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
