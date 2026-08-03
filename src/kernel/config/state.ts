//
// Daemon-owned bookkeeping, deliberately NOT config.json. config.json belongs
// to the user — `writeMode` goes out of its way to round-trip every field it
// does not own — and "have we already explained this" is not something a user
// sets. It still has to be on disk rather than in memory: a flag that resets
// when the daemon restarts turns "told once" into "told every restart", which
// is the exact spam this whole change removes.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface DaemonState {
  /** `<channel>:<chatId>` for every chat already told that notify mode keeps
   *  IM quiet. Append-only; membership is the whole semantics. */
  notifyExplainedChats?: string[];
  /** The linux desktop toast's current notify-send id, or null when nothing is
   *  live. Survives a daemon restart (or a `kill -9`) so the NEXT process can
   *  still close a toast its predecessor left behind — without this, clear()
   *  at startup has no id to act on and the toast is stranded forever. */
  toastId?: string | null;
}

const statePath = (home: string): string => join(home, 'state.json');

/** Never throws. A missing or unparsable state file means "we know nothing".
 *  For `notifyExplainedChats` that costs at most one re-sent explanation
 *  card — but `toastId` shares this same file, so degrading to `{}` can ALSO
 *  strand a live toast: the next `clear()` has no id to act on, and the
 *  notification sits there until dismissed by hand. Still strictly better
 *  than a daemon that will not start over a corrupt cache. */
export function readState(home: string): DaemonState {
  const p = statePath(home);
  if (!existsSync(p)) return {};

  // Guard the read: file may be unreadable or vanish after existsSync (TOCTOU race).
  // Degrading to {} costs at most one re-sent explanation card OR one stranded
  // toast — see the doc comment above.
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch {
    return {};
  }

  // Guard the parse: file exists but contains invalid JSON (half-written or
  // corrupt). `writeState` below writes atomically, so this should only ever
  // catch a file corrupted by something outside this module. Degrading to {}
  // costs at most one re-sent explanation card OR one stranded toast.
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    return {};
  }
}

/** Atomic write: a bare `writeFileSync` opens with O_TRUNC and then writes, so
 *  a kill between those two steps leaves a 0-byte `state.json` — which
 *  `readState` degrades exactly as it would a missing file, silently dropping
 *  whatever `toastId` was on disk along with it (I3). Writing to a sibling
 *  temp file in the SAME directory and `renameSync`-ing it over the target
 *  avoids that: rename is atomic within one filesystem, so any reader always
 *  sees either the complete old file or the complete new one, never a
 *  partial one. The whole read-modify-write callers do around this (see
 *  `markNotifyExplained` / `writeToastId`) must stay fully synchronous — no
 *  `await` between their `readState()` and this call — or two callers could
 *  interleave and one's write would clobber the other's field. This function
 *  does not close every gap on its own, though: a ~4ms window remains between
 *  `notify-send` rendering a toast and its id reaching `writeToastId` at all
 *  (desktop-notify.ts persists only after the spawned process's first line
 *  resolves) — a kill exactly there strands a toast with nothing on disk to
 *  reach it. That window is irreducible: you cannot atomically persist an id
 *  you do not have yet. */
function writeState(home: string, next: DaemonState): void {
  mkdirSync(home, { recursive: true });
  const target = statePath(home);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup; the throw below is what matters */ }
    throw e;
  }
}

export function wasNotifyExplained(home: string, chatKey: string): boolean {
  return (readState(home).notifyExplainedChats ?? []).includes(chatKey);
}

export function markNotifyExplained(home: string, chatKey: string): void {
  const state = readState(home);
  const chats = state.notifyExplainedChats ?? [];
  if (chats.includes(chatKey)) return;
  writeState(home, { ...state, notifyExplainedChats: [...chats, chatKey] });
}

export function readToastId(home: string): string | null {
  return readState(home).toastId ?? null;
}

/** Read-modify-write, same shape as `markNotifyExplained` — kept inside this
 *  module rather than exposing a generic `writeState` so the "every
 *  read-modify-write here must stay fully synchronous" rule lives in one
 *  place. `toastId` changes on every render, far more often than
 *  `notifyExplainedChats`, so this is the field most likely to race a
 *  concurrent writer if that rule is ever broken. */
export function writeToastId(home: string, id: string | null): void {
  const state = readState(home);
  writeState(home, { ...state, toastId: id });
}
