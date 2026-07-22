/** Single source of truth for shim event names. The plugin's hooks.json, the
 *  CLI usage line, and the docs are all checked against this list by the
 *  consistency tests (plugin-consistency.test.ts) — extend it here first. */
export const HOOK_EVENT_NAMES = [
  'post-tool-use',
  'stop',
  'notification',
  'user-prompt-submit',
  'session-start',
  'session-end',
  'post-tool-use-failure',
  'stop-failure',
  'subagent-start',
  'subagent-stop',
  'permission-request',
  'permission-denied',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export type HookVendor = 'claude' | 'codex';

export type NormalizedHook =
  // agentId:子 agent 的 hook 带 agent_id(两家都有)——用于把"本地答掉"精确
  // 关联回同一个 agent 的挂起审批,同 key 同 tool 的其他 agent 的卡不受影响。
  | { event: 'approval-request'; cwd: string; sessionId: string; toolName: string; input: unknown; permissionMode?: string; agentId?: string }
  | { event: 'activity'; cwd: string; sessionId: string; toolName: string; result: unknown; agentId?: string }
  | { event: 'attention'; cwd: string; sessionId: string; message: string; lastMessage?: string; stopHookActive?: boolean; droppable?: boolean }
  | { event: 'prompt'; cwd: string; sessionId: string; prompt: string }
  | { event: 'subagent'; cwd: string; sessionId: string; delta: 1 | -1; agentType?: string }
  | { event: 'session-start'; cwd: string; sessionId: string; source?: string }
  | { event: 'session-end'; cwd: string; sessionId: string; reason?: string }
  | { event: 'permission-denied'; cwd: string; sessionId: string; toolName: string };

/** Vendor-neutral monitoring subset carried over IPC `hook.event`. */
export type MonitorEvent = Extract<NormalizedHook, { event: 'activity' | 'attention' | 'prompt' | 'subagent' | 'session-start' | 'session-end' | 'permission-denied' }>;

/** Codex(app-server companion)和 CC(本文件 stop 事件)共用的"通用续跑占位
 *  文案"哨兵。agent 没留下真正的最后一句话时,attention/continue 的
 *  message/context 字段就落回这个值;daemon 层(bootstrap.ts)拿到 context
 *  后跟它做 === 比较,判定"没有可摘录的真实内容",从而清空续跑卡正文,只留
 *  标题 + `Reply to continue` 提示。三处(甚至更多)若各写各的字面量,任何一
 *  处漂移都会让这个比较失配,导致正文把标题原样再引用一遍——这正是本常量
 *  要消灭的重复。 */
export const TURN_FINISHED_SENTINEL = 'Turn finished — reply to continue';

interface RawHook {
  cwd?: string; session_id?: string; permission_mode?: string;
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; message?: string;
  prompt?: string; source?: string; reason?: string; last_assistant_message?: string;
  notification_type?: string;
  tool_error?: unknown;
  error_type?: string;
  agent_type?: string;
  stop_hook_active?: boolean;
  agent_id?: string;
}

export function parseHookInput(event: HookEventName, raw: unknown): NormalizedHook {
  const r = (raw ?? {}) as RawHook;
  const cwd = r.cwd ?? process.cwd();
  const sessionId = r.session_id ?? '';
  switch (event) {
    case 'permission-request':
      return { event: 'approval-request', cwd, sessionId, toolName: r.tool_name ?? '(unknown)', input: r.tool_input ?? {}, permissionMode: r.permission_mode, ...(r.agent_id ? { agentId: r.agent_id } : {}) };
    case 'permission-denied':
      return { event: 'permission-denied', cwd, sessionId, toolName: r.tool_name ?? '(unknown)' };
    case 'post-tool-use':
      return { event: 'activity', cwd, sessionId, toolName: r.tool_name ?? '(unknown)', result: r.tool_response ?? {}, ...(r.agent_id ? { agentId: r.agent_id } : {}) };
    case 'stop':
      // stop_hook_active = 本 turn 是被上一次 stop hook 唤醒的续跑;shim 据此
      // 不再等续跑,避免 async+asyncRewake 下的无限续跑循环。
      return { event: 'attention', cwd, sessionId, message: TURN_FINISHED_SENTINEL, ...(r.last_assistant_message ? { lastMessage: r.last_assistant_message } : {}), ...(r.stop_hook_active ? { stopHookActive: true } : {}) };
    case 'notification':
      // permission_prompt notifications are dropped in the shim (the parallel
      // PermissionRequest card already covers that moment); everything else
      // passes through verbatim.
      return { event: 'attention', cwd, sessionId, message: r.message ?? 'needs your attention' };
    case 'user-prompt-submit':
      return { event: 'prompt', cwd, sessionId, prompt: r.prompt ?? '' };
    case 'session-start':
      return { event: 'session-start', cwd, sessionId, ...(r.source ? { source: r.source } : {}) };
    case 'session-end':
      return { event: 'session-end', cwd, sessionId, ...(r.reason ? { reason: r.reason } : {}) };
    case 'post-tool-use-failure': {
      const err = typeof r.tool_error === 'string' ? r.tool_error : JSON.stringify(r.tool_error ?? '');
      // 语义上"空"的错误文本:真正空串/纯空白,或 JSON.stringify 序列化出的
      // 空壳(空对象 {}、null、双引号空串)——这些都不是"有效错误内容"。最常见
      // 的来源是 Bash 命令非零退出但 stderr 为空(grep 没命中/test 判假/
      // diff --quiet 这类正常非零退出),属于噪音,不该推告警到手机;有真正
      // 内容的失败(如 permission denied)不受影响,照常发。
      const trimmed = err.trim();
      const isEmptyError = trimmed === '' || trimmed === '{}' || trimmed === '""' || trimmed === "''" || trimmed === 'null';
      const tool = r.tool_name ?? '(unknown)';
      // No emoji prefix here — single responsibility: normalizer only normalizes
      // text. The ⚠️ prefix (for error-level notify) is bootstrap's call.
      //
      // droppable 只管 IM(bootstrap.ts 的 hook.notify handler 据此跳过
      // sendToChat)——dashboard 广播(events.broadcast)在那个 if 之外,不受
      // droppable 影响,始终照常收到这条 attention。这也是它唯一能看到这次
      // 工具活动的途径:CC 的 PostToolUse 与 PostToolUseFailure 互斥(同一次
      // 工具调用只触发其一,见 code.claude.com/docs/en/hooks),失败时
      // PostToolUse 根本不 fire,没有 activity 事件能替补。所以即使
      // droppable,message 也要保持人话可读——空错误时不带一对孤零零的空
      // 引号(`Bash failed: ""`),换成说人话的文案;有内容的失败照旧
      // `<tool> failed: <err>`。
      return {
        event: 'attention', cwd, sessionId,
        message: isEmptyError ? `${tool} failed (no error output)` : `${tool} failed: ${err.slice(0, 200)}`,
        ...(isEmptyError ? { droppable: true } : {}),
      };
    }
    case 'stop-failure':
      return { event: 'attention', cwd, sessionId, message: `session error: ${r.error_type ?? 'unknown'}` };
    case 'subagent-start':
      return { event: 'subagent', cwd, sessionId, delta: 1, ...(r.agent_type ? { agentType: r.agent_type } : {}) };
    case 'subagent-stop':
      return { event: 'subagent', cwd, sessionId, delta: -1, ...(r.agent_type ? { agentType: r.agent_type } : {}) };
  }
}

/** PermissionRequest decision wire — CC only now (Codex hooks are retired;
 *  app-server companion is the sole Codex integration).
 *  真机验证 allow/deny±message。与本地对话并行,先答先得;{} = 留给用户。
 *  绝不 auto-allow / auto-deny。updatedInput 仅用于 AskUserQuestion 作答
 *  (allow + {questions, answers},让 CC 把工具当已回答正常跑 —— 见 ask-renderer)。 */
export function permissionRequestDecisionOut(decision: 'allow' | 'deny' | 'defer', reason?: string, updatedInput?: unknown): object {
  if (decision === 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', ...(updatedInput !== undefined ? { updatedInput } : {}) } } };
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


/** session-start 欢迎提示:CC-only(Codex hooks 已退役),
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
