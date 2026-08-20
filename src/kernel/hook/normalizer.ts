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
  | { event: 'attention'; cwd: string; sessionId: string; message: string; lastMessage?: string; stopHookActive?: boolean; droppable?: boolean; localWaiting?: LocalWaiting; sessionError?: SessionError }
  | { event: 'prompt'; cwd: string; sessionId: string; prompt: string }
  | { event: 'subagent'; cwd: string; sessionId: string; delta: 1 | -1; agentType?: string }
  | { event: 'session-start'; cwd: string; sessionId: string; source?: string }
  | { event: 'session-end'; cwd: string; sessionId: string; reason?: string }
  | { event: 'permission-denied'; cwd: string; sessionId: string; toolName: string };

/** Something is stuck at the machine running the session and only whoever is
 *  sitting there can unstick it.
 *
 *  Two independent questions live in this one value, and folding them together
 *  is a bug waiting to happen — it was one, briefly, while this was being
 *  written:
 *
 *  1. **What do you call it?** `approval` and `relayed-approval` are yes-or-no
 *     decisions; `blocked` is a question waiting for an answer. Saying
 *     "approval needed" over an MCP dialog is a small lie, and this project
 *     keeps paying for those.
 *  2. **Could tlive already be holding a card for it?** Only for `approval`.
 *     There is no PermissionRequest behind an elicitation dialog, and Claude
 *     Code does not dispatch one for a teammate's relayed request at all — see
 *     anthropics/claude-code#82418. So for the other two, this notice is the
 *     only signal that exists, at every rung of the posture ladder, and the
 *     daemon's held-card and posture gates must not be asked about them. */
export type LocalWaiting = 'approval' | 'relayed-approval' | 'blocked';

/** Which of Claude Code's fourteen `notification_type` values mean someone is
 *  stuck. Read off the emission sites in 2.1.235 rather than guessed; the nine
 *  absent ones are news, not a call for help, and an unrecognised value is
 *  deliberately absent too — a new upstream type is not assumed to be waiting.
 *
 *  Two of these carry a 6-second idle gate upstream and two do not, which is
 *  Claude Code's business, not ours: it decides WHETHER the hook fires, and this
 *  map only decides what it means once it has. */
const LOCAL_WAITING_TYPES: Record<string, LocalWaiting> = {
  permission_prompt: 'approval',
  worker_permission_prompt: 'relayed-approval',
  elicitation_dialog: 'blocked',
  elicitation_url_dialog: 'blocked',
  agent_needs_input: 'blocked',
};

/** A turn that ended on an API error, with the one judgement the surfaces need
 *  from it. `transient` is Claude Code's OWN classification, not a guess of
 *  ours: its `apiErrorIsTransient === true || error === 'overloaded' || error
 *  === 'server_error'`. Only the two kinds survive into the hook payload, so
 *  that is what TRANSIENT_ERROR_KINDS mirrors — anything else, including a
 *  missing kind, counts as needing a human, because not knowing whether it
 *  passes is not the same as knowing it will.
 *
 *  `text` is `message` without its "session error: " prefix, for a surface
 *  whose title already says the turn failed. */
export interface SessionError { text: string; transient: boolean }

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

/** The kinds Claude Code retries its own way out of — a server hiccup, not a
 *  standing condition. Everything else (a bad key, an exhausted balance, a
 *  model that does not exist) stays broken until a human changes something. */
const TRANSIENT_ERROR_KINDS = new Set(['overloaded', 'server_error']);

interface RawHook {
  cwd?: string; session_id?: string; permission_mode?: string;
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; message?: string;
  prompt?: string; source?: string; reason?: string; last_assistant_message?: string;
  notification_type?: string;
  /** Both Claude Code failure payloads call it `error` — PostToolUseFailure
   *  {tool_name, tool_input, tool_use_id, error, is_interrupt?, duration_ms?}
   *  and StopFailure {error, error_details?, last_assistant_message?}. Taken
   *  from the shipped binary's own zod schemas; the /hooks help TEXT still
   *  advertises `error_type` and `is_timeout` and is stale against them, which
   *  is where the names this once read came from. `unknown` because a hook
   *  payload is untrusted input, not because the schema is loose. */
  error?: unknown;
  error_details?: string;
  is_interrupt?: boolean;
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
      // permission_prompt ("Claude needs your permission to use X") is TAGGED,
      // not dropped: whether it duplicates a live approval card is the daemon's
      // call, not the shim's (issue #49 — the old unconditional drop was a
      // full-mode assumption; in notify mode, or on a full-mode immediate
      // defer, there is no card and this is the ONLY signal a local dialog is
      // waiting). Everything else passes through verbatim.
      const waiting = r.notification_type ? LOCAL_WAITING_TYPES[r.notification_type] : undefined;
      return { event: 'attention', cwd, sessionId, message: r.message ?? 'needs your attention', ...(waiting ? { localWaiting: waiting } : {}) };
    case 'user-prompt-submit':
      return { event: 'prompt', cwd, sessionId, prompt: r.prompt ?? '' };
    case 'session-start':
      return { event: 'session-start', cwd, sessionId, ...(r.source ? { source: r.source } : {}) };
    case 'session-end':
      return { event: 'session-end', cwd, sessionId, ...(r.reason ? { reason: r.reason } : {}) };
    case 'post-tool-use-failure': {
      const err = typeof r.error === 'string' ? r.error : JSON.stringify(r.error ?? '');
      // 语义上"空"的错误文本:真正空串/纯空白,或 JSON.stringify 序列化出的
      // 空壳(空对象 {}、null、双引号空串)。只决定这条读起来是什么样 ——
      // 不带一对孤零零的空引号(`Bash failed: ""`),换成说人话的文案。
      const trimmed = err.trim();
      const isEmptyError = trimmed === '' || trimmed === '{}' || trimmed === '""' || trimmed === "''" || trimmed === 'null';
      const tool = r.tool_name ?? '(unknown)';
      // You pressed Esc. Claude Code reports the abort through the same failure
      // hook as a real error, but nothing failed and nobody needs telling: you
      // were at the keyboard when you did it. Same rule the Codex `interrupted`
      // outcome follows. The text says what actually happened instead of
      // "failed", because the dashboard still shows this.
      if (r.is_interrupt) return { event: 'attention', cwd, sessionId, message: `${tool} interrupted`, droppable: true };
      // droppable 只管 IM(bootstrap.ts 的 hook.notify handler 据此跳过
      // sendToChat)——dashboard 广播(events.broadcast)在那个 if 之外,不受
      // droppable 影响,始终照常收到这条 attention。这也是它唯一能看到这次
      // 工具活动的途径:CC 的 PostToolUse 与 PostToolUseFailure 互斥(同一次
      // 工具调用只触发其一,见 code.claude.com/docs/en/hooks),失败时
      // PostToolUse 根本不 fire,没有 activity 事件能替补。
      //
      // 工具失败**一律**不进 IM,理由不是"这条没内容",而是**没人需要为它做
      // 什么**:错误会原样回给 agent,它下一轮自己处理。本机 7 天 42 条真实
      // 失败(29 条是 `Exit code N` —— diff 有差异、grep 没命中、命令超时、
      // 我自己引号打错)里没有一条需要人介入,而每一条都会变成一条 ⚠️ 推到
      // 手机上。这与桌面通道同一条规则:只投递到"你在那儿能做点什么"的面上。
      // 整轮死掉(stop-failure)是另一回事,见下一个 case。
      // No emoji prefix here — single responsibility: normalizer only normalizes
      // text. The ⚠️ prefix (for error-level notify) is bootstrap's call.
      return {
        event: 'attention', cwd, sessionId,
        message: isEmptyError ? `${tool} failed (no error output)` : `${tool} failed: ${err.slice(0, 200)}`,
        droppable: true,
      };
    }
    case 'stop-failure': {
      // `error` is one of twelve kinds (rate_limit / overloaded /
      // authentication_failed / oauth_org_not_allowed / account_on_hold /
      // billing_error / invalid_request / model_not_found / server_error /
      // max_output_tokens / unknown). The kind alone tells you which bucket,
      // never what happened — `error_details` is the only human-readable half,
      // so it travels with it. Note `unknown` is itself one of the twelve: the
      // fallback below is indistinguishable from Claude Code genuinely not
      // knowing, and the details are what settle that either way.
      const kind = typeof r.error === 'string' && r.error ? r.error : 'unknown';
      const details = typeof r.error_details === 'string' ? r.error_details.trim() : '';
      const text = `${kind}${details ? ` — ${details.slice(0, 200)}` : ''}`;
      return { event: 'attention', cwd, sessionId, message: `session error: ${text}`, sessionError: { text, transient: TRANSIENT_ERROR_KINDS.has(kind) } };
    }
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


/** tlive 姿态梯子,单调递增:每一级都做前一级做的事,再多做一点。
 *  off = 全关 kill switch;notify = 只监看/通知,PermissionRequest 绝不 gating
 *  (默认,安全);full = hold 主会话审批(终端框并行,先答先得);all = 子代理
 *  审批也 hold(hold 期间子代理**没有**终端框,所以这是"没人在键盘前"的姿态)。
 *  shim 按此短路(见 modeShortCircuit);daemon 按此决定子代理拦不拦。 */
export type ShimMode = 'off' | 'notify' | 'full' | 'all';

/** Resolve a config `mode` value to the effective posture — the single source of
 *  the `notify` default. Unset / unknown / malformed all fall back to the safe
 *  `notify` (watch + notify, never gate). Used by the shim (readMode), the
 *  daemon (currentMode) and `tlive status`, so the displayed posture always
 *  matches the enforced one. */
export function effectiveMode(m: unknown): ShimMode {
  return m === 'off' || m === 'full' || m === 'all' ? m : 'notify';
}

/** session-start additionalContext(CC-only,Codex hooks 已退役)。分级引导:
 *  - IM 未配置 → 先引导配 IM(优先,没 IM 谈不上远程)。
 *  - IM 已配置但 mode 既非 full 也非 all(即仍在默认的 notify)→ 提示远程审批
 *    当前是关的,引导用 `tlive mode full` 打开(默认 notify 下的"卖点在一步之外"
 *    提示,兜住手动配了 IM 却没走 setup 的缝)。full/all 都已经是"远程审批开着",
 *    这里绝不能建议从 all 降级到 full——那是用户离开键盘前特意选的姿态。
 *  - IM 已配置且 full 或 all → {}(不打扰)。 */
export function sessionStartOut(vendor: HookVendor, imConfigured: boolean, mode: ShimMode): string {
  if (vendor !== 'claude') return '{}';
  if (!imConfigured) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'tlive 已就绪(hook 监看已挂载),但 IM 通知还没配置 — 用户说"帮我配置 tlive"或运行 /tlive:setup 即可由你引导完成。',
      },
    });
  }
  if (mode !== 'full' && mode !== 'all') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'tlive 的通知/监看已就绪,但远程审批(替你 hold 工具审批、可手机/桌面作答)当前是关的 — 用户想开启就运行 `tlive mode full`(或重跑 /tlive:setup)。',
      },
    });
  }
  return '{}';
}
