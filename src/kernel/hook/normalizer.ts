export type HookEventName = 'pre-tool-use' | 'post-tool-use' | 'stop' | 'notification';

export type NormalizedHook =
  | { event: 'approval-request'; cwd: string; sessionId: string; toolName: string; input: unknown; permissionMode?: string }
  | { event: 'activity'; cwd: string; sessionId: string; toolName: string; result: unknown }
  | { event: 'attention'; cwd: string; sessionId: string; message: string };

interface RawHook {
  cwd?: string; session_id?: string; permission_mode?: string;
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; message?: string;
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
      return { event: 'attention', cwd, sessionId, message: 'Claude 已完成,回复以续跑' };
    case 'notification':
      return { event: 'attention', cwd, sessionId, message: r.message ?? 'Claude 需要你' };
  }
}

export function permissionDecisionOut(decision: 'allow' | 'deny' | 'defer'): object {
  if (decision === 'defer') return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } };
}

export function continueDecisionOut(reply: string | null): object {
  return reply ? { decision: 'block', reason: reply } : {};
}
