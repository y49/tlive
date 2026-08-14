// The copy and the renderer for ONE desktop notification about ONE thing that
// is waiting for the user.
//
// This replaces the old aggregate projection (one toast listing everything
// waiting), and the reason is worth keeping: a notification is an EVENT, not
// a status display. An
// aggregate toast has to claim "N sessions are waiting", which is true for a
// few seconds and then sits in the notification centre's history lying about
// it — which is exactly how a toast raised by one project came to read as
// another project's approval. A notice that says "drama-admin needs approval
// for pnpm build" is true at the moment it fires and stays true forever, in
// the panel and in the history, which is what makes needing no lifecycle a
// consequence rather than a shortcut.
//
// Masking and the length cap live HERE, not at the call sites: three
// different sources feed `detail` — a summarized tool call, Claude Code's own
// sentence, an excerpt of the last assistant message — and a fourth will
// arrive one day. A desktop notification is visible on a lock screen and in a
// screen share, so that guarantee has to be structural.

import { maskSecrets } from '../permission/approval-renderer.js';

/** Why the user is being called. Drives the title's second half only. */
export type WaitKind = 'held' | 'subagent' | 'localPrompt' | 'idle';

/** Toast language, chosen once at daemon startup from the OS locale — see
 *  bootstrap.ts's `detectLang`. Unrecognised locales fall back to `en` ON
 *  PURPOSE: shipping a language nobody on this project can proofread is worse
 *  than shipping English. */
export type Lang = 'en' | 'zh';

export interface WaitingNotice {
  /** Session label, already resolved by the caller. '' on a registry miss —
   *  the title then degrades to the bare reason rather than a stray ' · '. */
  label: string;
  kind: WaitKind;
  /** One line saying what this actually is. '' when nothing is available, in
   *  which case the body is empty and the title carries the whole message. */
  detail: string;
}

/** Longest body this renders. The server clips at about two lines anyway; the
 *  point of an explicit cap is that it is testable and that it bounds what a
 *  lock screen can show. */
export const DETAIL_BUDGET = 90;

/** Reason copy. The `zh` column is the ONE deliberate exception to the
 *  project's English-only rule: it is runtime copy the end user reads on their
 *  OWN desktop, so it sits next to its English counterpart rather than in a
 *  resource file nobody reviews.
 *
 *  `held` and `localPrompt` read identically on purpose: one is an approval
 *  tlive is holding, the other a dialog only the terminal can answer, and to
 *  the person being called they are the same request. They stay separate kinds
 *  because their `detail` comes from different sources. Nothing here names a
 *  PLACE to answer in — a held approval may be answerable at the terminal or
 *  only remotely, and this cannot tell which. */
const REASON: Record<WaitKind, Record<Lang, string>> = {
  held: { en: 'approval needed', zh: '等你批准' },
  localPrompt: { en: 'approval needed', zh: '等你批准' },
  subagent: { en: 'sub-agent needs approval', zh: '子代理等你批准' },
  idle: { en: 'waiting for your input', zh: '等你输入' },
};

export function renderWaiting(n: WaitingNotice, lang: Lang): { title: string; body: string } {
  const reason = REASON[n.kind][lang];
  const flat = maskSecrets(n.detail.replace(/\s+/g, ' ').trim());
  const body = flat.length > DETAIL_BUDGET ? `${flat.slice(0, DETAIL_BUDGET - 1)}…` : flat;
  return { title: n.label ? `${n.label} · ${reason}` : reason, body };
}
