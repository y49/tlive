// src/im/reply-document/format-feishu.ts
//
// renderFeishu — pure HudState + body → lark card 2.0.
// v3.1 hotfix 2026-04-30: progress chips promoted into the visible body so
// users see tool activity without needing to scroll/hover. Detail metadata
// (turn header, branch, context bar, session cost) lives in the note region
// at the bottom — still visible (lark card body is fully expanded by default)
// but visually de-emphasized.
//
// Body element order:
//   1. progress markdown — banner-style line + tally chips + ⏱ + 💵
//   2. hr                — separates progress from reply body
//   3. body markdown     — assistant text
//   4. hr
//   5. detail markdown   — 💬 turn / model / context bar / session cost

import type { HudState } from '../hud/state.js';

export interface FeishuRender { card: object; }

const BAR_WIDTH = 10;

function bar(pct: number): string {
  const safe = Number.isFinite(pct) ? pct : 0;
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((safe / 100) * BAR_WIDTH)));
  return '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}
function fmtDur(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }
function fmtCost(n: number): string { return `$${n.toFixed(2)}`; }
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function elapsedMsForRender(state: HudState, now: number): number {
  if (state.isFrozen || state.isErrored) return state.durationMs;
  return Math.max(0, now - state.startedAtMs);
}

/**
 * v3.2.2 adaptive truth: returns null when frozen with 0 cost (provider
 * didn't surface cost data) so caller can suppress the entire segment.
 */
function fmtCostForFeishu(n: number, isFinal: boolean): string | null {
  if (!isFinal) return '💵 –.--';
  if (n <= 0) return null;
  return `💵 $${n.toFixed(2)}`;
}

function templateAndPrefix(state: HudState): { template: string; prefix: string } {
  if (state.isErrored) return { template: 'red', prefix: '❌' };
  if (state.isFrozen) return { template: 'green', prefix: '✓' };
  if (state.askPending) return { template: 'turquoise', prefix: '❓' };
  if (state.currentActivity?.kind === 'waiting_permission') return { template: 'yellow', prefix: '⏸' };
  return { template: 'blue', prefix: '◐' };
}

function progressMarkdown(state: HudState, now: number): string {
  const parts: string[] = [];
  // Active activity line (if any)
  const a = state.currentActivity;
  if (a?.kind === 'tool_running') {
    const arg = a.toolArg ? ` · ${a.toolArg}` : '';
    parts.push(`<font color='orange'>◐ ${a.toolName}${arg} · ${fmtDur(a.elapsedMs)}</font>`);
  } else if (a?.kind === 'thinking') {
    parts.push(`<font color='grey'>◐ thinking · ${fmtDur(a.elapsedMs)}</font>`);
  } else if (a?.kind === 'waiting_permission') {
    parts.push(`<font color='yellow'>⏸ ${a.toolName ?? ''}</font>`);
  }
  // Tally chips
  if (state.toolTally.size > 0) {
    const chips: string[] = [];
    for (const [n, c] of state.toolTally) chips.push(`✓ ${n}×${c}`);
    parts.push(chips.join(' · '));
  }
  // In-progress todos
  for (const t of state.todoList) {
    if (t.status === 'in_progress') parts.push(`▶ ${t.text}`);
  }
  // Always-visible time anchor + cost (suppressed when frozen with 0 cost)
  const isFinal = state.isFrozen || state.isErrored;
  const elapsed = `⏱ ${fmtDur(elapsedMsForRender(state, now))}`;
  const cost = fmtCostForFeishu(state.costThisTurn, isFinal);
  parts.push(cost !== null ? `${elapsed} · ${cost}` : elapsed);
  return parts.join('\n');
}

function detailMarkdown(state: HudState): string {
  const lines: string[] = [];
  const ctxKnown = state.modelMaxContext > 0;
  // L1 — turn header. `(maxK)` only when we know the max.
  const ctxLabel = ctxKnown ? ` (${fmtTok(state.modelMaxContext)})` : '';
  lines.push(`💬 #${state.turnNumber} · ${state.sessionShortId} · ${state.model}${ctxLabel}`);
  if (state.gitBranch) lines.push(`🌳 ${state.gitBranch} · ${state.workspaceName}`);
  // Context line — adaptive (v3.2.2):
  if (ctxKnown) {
    const ctxPct = Math.round((state.contextUsedTok / state.modelMaxContext) * 100);
    lines.push(`**Context** ${bar(ctxPct)} ${ctxPct}% (${fmtTok(state.contextUsedTok)}/${fmtTok(state.modelMaxContext)})`);
  } else if (state.contextUsedTok > 0) {
    lines.push(`**Context** ${fmtTok(state.contextUsedTok)} tokens`);
  }
  for (const q of state.quotaBars) {
    const reset = q.resetsIn ? ` (${q.resetsIn})` : '';
    lines.push(`**${q.label}** ${bar(q.pct)} ${q.pct}%${reset}`);
  }
  // Σ session cost — only when provider supplied real cost data
  if (state.costSession > 0) {
    lines.push(`Σ ${fmtCost(state.costSession)}`);
  }
  return lines.join('\n');
}

/**
 * Default 4-button action row for the detail card. Stop button label/value
 * differ by turn state (mirrors Telegram's `defaultDetailKeyboard`):
 *   in-flight → '⏸ 中断' / 'turn:stop'
 *   idle      → '⏸'    / 'turn:stop:idle'
 *
 * Lark card 2.0 dropped `tag: 'action'` (the legacy v1 wrapper). Buttons
 * in v2 must live inside a `column_set` so each button gets its own
 * column for horizontal layout. value.callback is what the inbound
 * listener relays back to CallbackRouter (see parseCardAction).
 */
function defaultDetailActions(state: HudState): object {
  const inFlight = !state.isFrozen && !state.isErrored;
  const stopText = inFlight ? '⏸ 中断' : '⏸';
  const stopCb = inFlight ? 'turn:stop' : 'turn:stop:idle';
  const buttons: Array<{ text: string; cb: string; primary?: boolean }> = [
    { text: '🆕 new', cb: 'session:new', primary: true },
    { text: '📋 list', cb: 'session:list' },
    { text: stopText, cb: stopCb },
    { text: '⋯', cb: 'menu:expand' },
  ];
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: buttons.map((b) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'top',
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: b.text },
        type: b.primary ? 'primary' : 'default',
        value: { callback_data: b.cb },
      }],
    })),
  };
}

export function renderFeishu(state: HudState, body: string, now: number = Date.now()): FeishuRender {
  const { template, prefix } = templateAndPrefix(state);
  const card = {
    schema: '2.0',
    header: {
      template,
      title: { tag: 'plain_text', content: `${prefix} #${state.turnNumber} · ${state.sessionShortId}` },
      subtitle: { tag: 'plain_text', content: state.model },
    },
    body: {
      elements: [
        { tag: 'markdown', content: progressMarkdown(state, now) },
        { tag: 'hr' },
        { tag: 'markdown', content: body.trim() ? body : '_thinking…_' },
        { tag: 'hr' },
        { tag: 'markdown', content: detailMarkdown(state) },
        defaultDetailActions(state),
      ],
    },
  };
  return { card };
}
