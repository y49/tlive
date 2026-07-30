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
}

const statePath = (home: string): string => join(home, 'state.json');

/** Never throws. A missing or unparsable state file means "we know nothing",
 *  and the worst consequence of that is re-sending one explanation card —
 *  strictly better than a daemon that will not start over a corrupt cache. */
export function readState(home: string): DaemonState {
  const p = statePath(home);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')) as DaemonState; } catch { return {}; }
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
