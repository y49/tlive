// src/kernel/daemon/local-prompts.ts
//
// Tracks CC-native permission dialogs the daemon only knows about through
// Notification(permission_prompt) — i.e. dialogs tlive is NOT holding: notify
// mode (the shim short-circuits permission-request entirely), or a full-mode
// request the router deferred on arrival for lack of an answer surface
// (issue #49). These are "someone is waiting at the terminal" facts, not
// held wire requests — hence a separate tracker instead of PermissionRouter
// entries (a router entry resolves a shim reply; there is no shim waiting
// here). bootstrap.ts uses this to drive the desktop toast lifecycle, the
// dashboard's read-only waiting-approval card, and the grace-delayed IM text,
// and clears entries from the same local-answer triggers that release held
// cards (PostToolUse / PermissionDenied / UserPromptSubmit / SessionEnd).

/** 关联字段匹配:双方都带且非空才比较;任一侧缺失 = 通配(保守方向 —— 宁可
 *  多清一个条目:清除只是收回通知,不动任何决策)。与 permission-router 的
 *  fieldMatches 同一条规则。 */
function fieldMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  return a === b;
}

export class LocalPrompts {
  // One slot per session key: CC's permission dialog is modal, so a session
  // has at most one dialog up — a re-note replaces the previous entry.
  private byKey = new Map<string, { sessionId?: string }>();

  note(key: string, sessionId?: string): void {
    this.byKey.set(key, sessionId ? { sessionId } : {});
  }

  has(key: string, sessionId?: string): boolean {
    const e = this.byKey.get(key);
    return e !== undefined && fieldMatches(e.sessionId, sessionId);
  }

  /** Remove the entry if it matches. Returns whether one was removed — the
   *  caller uses that to know a dashboard/toast update is due. */
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
