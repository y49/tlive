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
   *  the localized `WHAT.permission` / `WHAT.yourInput` (below) — the caller
   *  (bootstrap.ts) resolves those through this file's `Lang` table before
   *  the entry ever reaches here. NEVER a guess — see the spec's note on
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

/** Toast language. This is the ONE deliberate exception to the project's
 *  English-only rule for code/comments/tests/docs/CLI/IM copy (see
 *  feedback_english_default in project memory): the strings below are
 *  runtime copy the end user reads on their OWN desktop, not project-facing
 *  text, so a Chinese entry sits right next to its English counterpart
 *  rather than living in a separate resource file no one reviews.
 *
 *  Chosen once, at daemon startup, from the OS locale — see bootstrap.ts's
 *  `detectLang`. The daemon never re-reads it mid-run, so a system language
 *  change needs `tlive stop && tlive start` to take effect, same as any
 *  other startup-only config.
 *
 *  Unrecognised locales fall back to `en` ON PURPOSE: shipping a language
 *  nobody on this project can proofread is worse than shipping English. */
export type Lang = 'en' | 'zh';

/** Single-entry bodies. The toast's job is to call the user back to the
 *  terminal — it never names a place: a `held` entry may be a main-session
 *  approval (answerable at the terminal) or an `all`-rung held sub-agent
 *  (answerable only remotely), and the two are indistinguishable here, so
 *  naming one would be wrong in the other case. No trailing punctuation — a
 *  toast is glanced at, not read. */
const BODY: Record<WaitKind, Record<Lang, string>> = {
  held: { en: 'Approval needed', zh: '等你批准' },
  subagent: { en: 'Answer at your terminal', zh: '回终端处理' },
  localPrompt: { en: 'Answer at your terminal', zh: '回终端处理' },
  idle: { en: 'Waiting for your input', zh: '等你输入' },
};

/** The two non-tool `what` values a `WaitingEntry` can carry (a real tool
 *  name is the third, and — like session labels — is a proper noun that is
 *  NEVER translated). These are produced at bootstrap.ts's registration
 *  sites, not inside `renderBoard`, but drawn from this same table so the
 *  strings live in exactly one place. */
export const WHAT: Record<'permission' | 'yourInput', Record<Lang, string>> = {
  permission: { en: 'permission', zh: '权限' },
  yourInput: { en: 'your input', zh: '你的输入' },
};

/** Aggregate title templates. "3 sessions need you" would be a lie for three
 *  dialogs in one session, so the one-session and many-session cases are
 *  worded (and pluralised in English's case, trivially) differently. */
const AGGREGATE_MANY: Record<Lang, (n: number) => string> = {
  en: (n) => `${n} sessions need you`,
  zh: (n) => `${n} 个会话在等你`,
};
const AGGREGATE_ONE: Record<Lang, (label: string, n: number) => string> = {
  en: (label, n) => `${label} · ${n} waiting`,
  zh: (label, n) => `${label} · ${n} 个在等`,
};
/** Placeholder for the one-session aggregate title when `label` is '' (a
 *  registry miss) — not a session name, so unlike a real label it IS
 *  translated, the same as every other word in that template. */
const THIS_SESSION: Record<Lang, string> = { en: 'This session', zh: '本会话' };

const line = (e: WaitingEntry): string => (e.label ? `${e.label} · ${e.what}` : e.what);

/** The toast for this board state, or null when nothing waits (caller clears).
 *  Aggregate — never one toast per entry: a machine-wide stack of toasts is the
 *  thing this design removes. Pure: `lang` is passed in rather than detected
 *  here, so both languages are directly unit-testable without a daemon. */
export function renderBoard(entries: WaitingEntry[], lang: Lang): { title: string; body: string } | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const e = entries[0]!;
    return { title: line(e), body: BODY[e.kind][lang] };
  }
  const sessions = new Set(entries.map((e) => e.key));
  const title = sessions.size === 1
    ? AGGREGATE_ONE[lang](entries[0]!.label || THIS_SESSION[lang], entries.length)
    : AGGREGATE_MANY[lang](sessions.size);
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
