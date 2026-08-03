// The ONE answer to "is anything waiting for the user, and what". Every
// desktop notification is a projection of this set: it changes → re-render,
// it empties → clear. Pure data + pure formatting, no IO, so the policy is
// testable without spawning anything.
//
// This exists because the predicate used to be duplicated at three call sites
// and two copies silently forgot sub-agent pass-throughs, so one session's
// approval resolving closed another's still-live toast. A predicate derived
// from the data cannot drift from it: the only way to make something wait is
// to put it here, and `isEmpty()` therefore cannot forget a category.

/** Why someone is waiting. Drives the single-entry body wording only —
 *  aggregate rendering treats every kind identically. */
export type WaitKind = 'held' | 'subagent' | 'localPrompt' | 'idle';

export interface WaitingEntry {
  /** Board identity. Stable per waiting thing so retirement can find it:
   *  requestId (held), passthruKey (subagent), `local:<key>` / `idle:<key>`. */
  id: string;
  /** Registry session key — used to count distinct SESSIONS, not dialogs. */
  key: string;
  /** Session label, already resolved by the caller. May be '' on a registry
   *  miss; rendering degrades to the bare `what` rather than a stray ' · '. */
  label: string;
  kind: WaitKind;
  /** What is being waited on: a real tool name where one is known, otherwise
   *  'permission' / 'your input'. NEVER a guess — see the spec's note on
   *  permission_prompt carrying no tool_name. */
  what: string;
}

export class WaitingBoard {
  // Map preserves insertion order, and re-setting an existing key keeps that
  // key's original position — so a replaced entry does not jump to the end and
  // reshuffle the toast under the user's eyes.
  private byId = new Map<string, WaitingEntry>();

  add(entry: WaitingEntry): void {
    this.byId.set(entry.id, entry);
  }

  /** Retire an entry. Returns whether one was actually removed, so callers can
   *  skip a pointless re-render. Unknown ids are a no-op: retirement signals
   *  fire from several paths and double-retirement is normal, not an error. */
  remove(id: string): boolean {
    return this.byId.delete(id);
  }

  /** Retire every entry matching `pred`. For retirement signals that know only
   *  an entry's visible fields (session key, kind, `what`) and cannot
   *  construct its id — e.g. CC's PermissionDenied hook carries no agentId at
   *  all, so a `subagent` entry's `passthruKey(key, agentId, toolName)` is
   *  unbuildable from it. Returns whether anything was removed, same contract
   *  as `remove`. */
  removeWhere(pred: (e: WaitingEntry) => boolean): boolean {
    let removed = false;
    for (const [id, e] of this.byId) {
      if (pred(e)) { this.byId.delete(id); removed = true; }
    }
    return removed;
  }

  isEmpty(): boolean {
    return this.byId.size === 0;
  }

  size(): number {
    return this.byId.size;
  }

  entries(): WaitingEntry[] {
    return [...this.byId.values()];
  }
}

/** Single-entry bodies. The toast's job is to call the user back to wherever
 *  the answer lives, so the wording differs by where that is: the dashboard
 *  (held — tlive owns the request) or the terminal (everything else). */
const BODY: Record<WaitKind, string> = {
  held: 'Approval needed — click to open and answer',
  subagent: 'Waiting at the terminal — answer it there.',
  localPrompt: 'Waiting at the terminal — answer it there.',
  idle: 'Waiting for your input at the terminal.',
};

const line = (e: WaitingEntry): string => (e.label ? `${e.label} · ${e.what}` : e.what);

/** The toast for this board state, or null when nothing waits (caller clears).
 *  Aggregate — never one toast per entry: a machine-wide stack of toasts is the
 *  thing this design removes. */
export function renderBoard(entries: WaitingEntry[]): { title: string; body: string } | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const e = entries[0]!;
    return { title: line(e), body: BODY[e.kind] };
  }
  const sessions = new Set(entries.map((e) => e.key));
  // "3 sessions need you" would be a lie for three dialogs in one session, and
  // the count is the whole informational payload of the title.
  const title = sessions.size === 1
    ? `${entries[0]!.label || 'This session'} · ${entries.length} waiting`
    : `${sessions.size} sessions need you`;
  return { title, body: entries.map((e) => `• ${line(e)}`).join('\n') };
}

/** Whether a projection can be skipped because it would change nothing the
 *  user can see. Pure so both halves of the condition are directly testable —
 *  the `alert` half guards a case that is not reachable through today's IPC
 *  surface but would be the moment any caller batches an add and a remove into
 *  one refresh, and an unreachable-but-correct guard still has to be pinned. */
export function canSkipProjection(
  lastView: { title: string; body: string } | null,
  view: { title: string; body: string },
  alert: boolean,
): boolean {
  return !alert && lastView !== null && lastView.title === view.title && lastView.body === view.body;
}
