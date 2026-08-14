// src/kernel/daemon/local-prompts.ts
//
// Tracks CC-native permission dialogs the daemon only knows about through
// Notification(permission_prompt) — i.e. dialogs tlive is NOT holding: notify
// mode (the shim short-circuits permission-request entirely), or a full-mode
// request the router deferred on arrival for lack of an answer surface
// (issue #49). These are "someone is waiting at the terminal" facts, not
// held wire requests — hence a separate tracker instead of PermissionRouter
// entries (a router entry resolves a shim reply; there is no shim waiting
// here). bootstrap.ts uses this to drive the dashboard's read-only
// waiting-approval card and the grace-delayed IM text, and clears entries from
// the same local-answer triggers that release held cards (PostToolUse /
// PermissionDenied / UserPromptSubmit / SessionEnd).

/** 关联字段匹配:双方都带且非空才比较;任一侧缺失 = 通配(保守方向 —— 宁可
 *  多清一个条目:清除只是收回通知,不动任何决策)。与 permission-router 的
 *  fieldMatches 同一条规则。 */
function fieldMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  return a === b;
}

export class LocalPrompts {
  // One slot per session key, and that is a deliberate under-approximation, not
  // a claim that only one dialog can exist. A backgrounded sub-agent's dialog is
  // live at the same time as the main thread's, so a session really can have
  // several up at once — but the only event that reaches us here (CC's
  // permission_prompt Notification) carries neither tool_name nor agent_id, and
  // its session_id is the main session's either way. There is nothing to key a
  // second slot on. Consequence: with concurrent dialogs, a re-note replaces the
  // previous entry and one clear retires both, so a reminder can be dropped
  // early. That only ever loses a reminder — decisions never flow through here.
  private byKey = new Map<string, { sessionId?: string }>();

  note(key: string, sessionId?: string): void {
    this.byKey.set(key, sessionId ? { sessionId } : {});
  }

  has(key: string, sessionId?: string): boolean {
    const e = this.byKey.get(key);
    return e !== undefined && fieldMatches(e.sessionId, sessionId);
  }

  /** Remove the entry if it matches. Returns whether one was removed, for
   *  the caller's information only — bootstrap.ts's clearLocalPrompt
   *  deliberately does not gate its registry cleanup on this value (see the
   *  comment there for why). */
  clear(opts: { key: string; sessionId?: string }): boolean {
    const e = this.byKey.get(opts.key);
    if (!e || !fieldMatches(e.sessionId, opts.sessionId)) return false;
    this.byKey.delete(opts.key);
    return true;
  }

  count(): number {
    return this.byKey.size;
  }
}
