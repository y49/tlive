// src/im/reply-document/format-telegram.ts
//
// renderTelegram — pure HudState + body → Telegram HTML.
// 4-zone layout (v3.1 hotfix 2026-04-30):
//   1. banner          — bold emoji status (◐ thinking / ◐ Read / ✓ done / ❌ error / ❓ awaiting / ⏸ waiting)
//   2. progress line   — ALWAYS VISIBLE: tally chips · ⏱ duration · 💵 cost
//                        so the user sees tool activity without expanding the footer
//                        (Q5 — "HUD 折叠看不到 tool 调用,以为卡了")
//   3. body            — assistant markdown rendered to HTML, fence code preserved
//   4. detail footer   — <blockquote expandable> with turn header / branch / Context / Σ session
//                        collapsed by default (1-line preview)
//
// Inspired by claude-hud's multi-line statusline layout.

import type { HudState } from '../hud/state.js';
import { escapeHtml } from '../util/html.js';
import { markdownToTelegramHtml } from './markdown.js';

export interface TelegramRender { html: string; }

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

function progressLine(state: HudState): string {
  const parts: string[] = [];
  if (state.toolTally.size > 0) {
    const chips: string[] = [];
    for (const [n, c] of state.toolTally) chips.push(`✓ ${escapeHtml(n)}×${c}`);
    parts.push(chips.join(' · '));
  }
  for (const t of state.todoList) {
    if (t.status === 'in_progress') parts.push(`▶ ${escapeHtml(t.text)}`);
  }
  // Always show ⏱ + 💵 anchors so the line is never empty (e.g. first turn
  // before any tool has finished).
  parts.push(`⏱ ${fmtDur(state.durationMs)}`);
  parts.push(`💵 ${fmtCost(state.costThisTurn)}`);
  return parts.join(' · ');
}

function footer(state: HudState): string {
  const lines: string[] = [];
  const sid = escapeHtml(state.sessionShortId);
  const model = escapeHtml(state.model);
  const maxK = fmtTok(state.modelMaxContext);
  // L1 — turn / session / model. 💬 (chat bubble) matches "conversation turn"
  // semantic better than 📊 (which read as "stats" and confused users).
  // # prefix on turn number reads as "round 2" without ambiguity vs "session 2".
  lines.push(`💬 #${state.turnNumber} · ${sid} · ${model} (${maxK})`);
  if (state.gitBranch) {
    lines.push(`🌳 ${escapeHtml(state.gitBranch)} · ${escapeHtml(state.workspaceName)}`);
  }

  const ctxPct = state.modelMaxContext > 0
    ? Math.round((state.contextUsedTok / state.modelMaxContext) * 100)
    : 0;
  lines.push(`Context ${bar(ctxPct)} ${ctxPct}% (${fmtTok(state.contextUsedTok)}/${maxK})`);

  for (const q of state.quotaBars) {
    const reset = q.resetsIn ? ` (${escapeHtml(q.resetsIn)})` : '';
    lines.push(`${escapeHtml(q.label)} ${bar(q.pct)} ${q.pct}%${reset}`);
  }

  lines.push(`Σ ${fmtCost(state.costSession)}`);
  return `<blockquote expandable>\n${lines.join('\n')}\n</blockquote>`;
}

export function renderTelegram(state: HudState, body: string): TelegramRender {
  const bodyHtml = body.trim() ? markdownToTelegramHtml(body) : '<i>thinking…</i>';
  const html = [
    banner(state),
    progressLine(state),
    '',
    bodyHtml,
    '',
    footer(state),
  ].join('\n');
  return { html };
}
