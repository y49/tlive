//
// Daemon-owned bookkeeping, deliberately NOT config.json. config.json belongs
// to the user — `writeMode` goes out of its way to round-trip every field it
// does not own — and "have we already explained this" is not something a user
// sets. It still has to be on disk rather than in memory: a flag that resets
// when the daemon restarts turns "told once" into "told every restart", which
// is the exact spam this whole change removes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

/** Never throws. A missing or unparsable state file means "we know nothing",
 *  and the worst consequence of that is re-sending one explanation card —
 *  strictly better than a daemon that will not start over a corrupt cache. */
export function readState(home: string): DaemonState {
  const p = statePath(home);
  if (!existsSync(p)) return {};

  // Guard the read: file may be unreadable or vanish after existsSync (TOCTOU race).
  // Degrading to {} costs at most one re-sent explanation message.
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch {
    return {};
  }

  // Guard the parse: file exists but contains invalid JSON (half-written or corrupt).
  // Degrading to {} costs at most one re-sent explanation message.
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    return {};
  }
}

function writeState(home: string, next: DaemonState): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(statePath(home), JSON.stringify(next, null, 2));
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
