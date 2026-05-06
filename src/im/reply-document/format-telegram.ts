// src/im/reply-document/format-telegram.ts
//
// renderTelegramReply — banner + progress + body (the chat-bubble message)
// renderTelegramDetail — <pre><code> monospace stats card (separate message)
//
// v3.2 hotfix 2026-04-30: split from a single render into two so the
// detail card lives in its own Telegram message, freeing the body to
// chunk on >4096 chars without touching the detail card. Also accepts
// an injectable `now: number` for live-elapsed rendering — render is
// called from scheduler's silence-tick (1.5s) so elapsed naturally ticks.

import type { HudState } from '../hud/state.js';
import type { ReplyMarkup } from '../../platform/types.js';
import { escapeHtml } from '../util/html.js';
import { markdownToTelegramHtml } from './markdown.js';

export interface TelegramRender {
  html: string;
  /** Optional inline-keyboard markup. Only set on the detail card. */
  replyMarkup?: ReplyMarkup;
}

const BAR_WIDTH = 10;

function bar(pct: number): string {
  const safe = Number.isFinite(pct) ? pct : 0;
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((safe / 100) * BAR_WIDTH)));
  return '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(1)}s`;
}

/**
 * Cost segment for the progress line. v3.2.2 adaptive truth:
 * - During turn (!isFinal): always show '💵 –.--' placeholder so user
 *   knows cost is being computed.
 * - Frozen (isFinal): show '💵 $X.XX' if there's any cost; otherwise
 *   return null — caller suppresses the segment entirely. Provider didn't
 *   surface cost (or truly 0) — don't fake '$0.00'.
 */
function fmtCost(n: number, isFinal: boolean): string | null {
  if (!isFinal) return '💵 –.--';
  if (n <= 0) return null;
  return `💵 $${n.toFixed(2)}`;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function elapsedMs(state: HudState, now: number): number {
  if (state.isFrozen || state.isErrored) return state.durationMs;
  return Math.max(0, now - state.startedAtMs);
}

function banner(state: HudState): string {
  if (state.isErrored) return `<b>❌ error · ${escapeHtml(state.errorSummary ?? '')}</b>`;
  if (state.isFrozen) return `<b>✓ done</b>`;
  if (state.askPending) return `<b>❓ awaiting input</b>`;
  const a = state.currentActivity;
  if (a?.kind === 'waiting_permission') {
    return `<b>⏸ waiting for permission · ${escapeHtml(a.toolName ?? '')}</b>`;
  }
  if (a?.kind === 'tool_running') {
    const arg = a.toolArg ? ` <code>${escapeHtml(a.toolArg)}</code>` : '';
    return `<b>◐ ${escapeHtml(a.toolName ?? 'tool')}</b>${arg}`;
  }
  return `<b>◐ thinking</b>`;
}

function progressLine(state: HudState, now: number): string {
  const parts: string[] = [];
  if (state.toolTally.size > 0) {
    const chips: string[] = [];
    for (const [n, c] of state.toolTally) chips.push(`✓ ${escapeHtml(n)}×${c}`);
    parts.push(chips.join(' · '));
  }
  for (const t of state.todoList) {
    if (t.status === 'in_progress') parts.push(`▶ ${escapeHtml(t.text)}`);
  }
  parts.push(`⏱ ${fmtDur(elapsedMs(state, now))}`);
  const costSeg = fmtCost(state.costThisTurn, state.isFrozen || state.isErrored);
  if (costSeg !== null) parts.push(costSeg);
  return `<i>${parts.join(' · ')}</i>`;
}

export function renderTelegramReply(
  state: HudState,
  body: string,
  now: number = Date.now(),
): TelegramRender {
  const bodyHtml = body.trim() ? markdownToTelegramHtml(body) : '<i>thinking…</i>';
  const html = [
    banner(state),
    progressLine(state, now),
    '',
    bodyHtml,
  ].join('\n');
  return { html };
}

export function renderTelegramDetail(state: HudState): TelegramRender {
  // v3.2.3: switched container from <pre><code> (gray "code block" with
  // copy button — looked like pasted code) to <blockquote> with inline tag
  // styling. Visual hierarchy via <b> (key numbers), <code> (data: sid /
  // branch), <i> (auxiliary: model id / max ctx). emoji as line anchors.
  // Character progress bar (▓░░...) retired — '📊 5%' is more chat-native;
  // the number itself carries the information without ASCII art.
  const lines: string[] = [];
  const sid = escapeHtml(state.sessionShortId);
  const model = escapeHtml(state.model);
  const ctxKnown = state.modelMaxContext > 0;
  // L1 — turn header.
  // 💬 <b>#N</b> · <code>sid</code>  <i>model · maxLabel</i>
  const modelParts = [model];
  if (ctxKnown) modelParts.push(fmtTok(state.modelMaxContext));
  const modelInfo = `<i>${modelParts.join(' · ')}</i>`;
  lines.push(`💬 <b>#${state.turnNumber}</b> · <code>${sid}</code>  ${modelInfo}`);
  // L2 — git context (omit if no branch)
  if (state.gitBranch) {
    lines.push(
      `🌳 <code>${escapeHtml(state.gitBranch)}</code> · <i>${escapeHtml(state.workspaceName)}</i>`,
    );
  }
  // L3 — context + cost (adaptive truth):
  //   - ctx known:        '📊 <b>5%</b> <i>(47.2k/1M)</i>  💰 <b>$1.16</b>'
  //   - ctx unknown:      '📊 <b>47.2k</b> <i>tokens</i>     💰 <b>$1.16</b>'
  //   - cost 0 (provider didn't surface): segment omitted
  const segs: string[] = [];
  if (ctxKnown) {
    const pct = Math.round((state.contextUsedTok / state.modelMaxContext) * 100);
    const detail = `${fmtTok(state.contextUsedTok)}/${fmtTok(state.modelMaxContext)}`;
    segs.push(`📊 <b>${pct}%</b> <i>(${detail})</i>`);
  } else if (state.contextUsedTok > 0) {
    segs.push(`📊 <b>${fmtTok(state.contextUsedTok)}</b> <i>tokens</i>`);
  }
  if (state.costSession > 0) {
    segs.push(`💰 <b>$${state.costSession.toFixed(2)}</b>`);
  }
  if (segs.length > 0) lines.push(segs.join('  '));
  // Quota lines (Anthropic-supplied)
  for (const q of state.quotaBars) {
    const reset = q.resetsIn ? ` <i>(${escapeHtml(q.resetsIn)})</i>` : '';
    lines.push(`📈 <b>${q.pct}%</b> <i>${escapeHtml(q.label)}</i>${reset}`);
  }
  return {
    html: `<blockquote>${lines.join('\n')}</blockquote>`,
    replyMarkup: defaultDetailKeyboard(state),
  };
}

/**
 * Default 4-button keyboard for the detail card. Stop button visual + callback
 * differ by turn state:
 *   - in-flight (not frozen, not errored) → '⏸ 中断' / 'turn:stop'
 *   - idle (frozen or errored)             → '⏸'    / 'turn:stop:idle'
 * The router uses the suffix to send a softer "no active turn" reply.
 */
function defaultDetailKeyboard(state: HudState): ReplyMarkup {
  const inFlight = !state.isFrozen && !state.isErrored;
  const stopText = inFlight ? '⏸ 中断' : '⏸';
  const stopCb = inFlight ? 'turn:stop' : 'turn:stop:idle';
  return {
    type: 'inline_keyboard',
    buttons: [[
      { text: '🆕 new', callbackData: 'session:new' },
      { text: '📋 list', callbackData: 'session:list' },
      { text: stopText, callbackData: stopCb },
      { text: '⋯', callbackData: 'menu:expand' },
    ]],
  };
}
