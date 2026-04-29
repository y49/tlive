// src/im/reply-document/format-telegram.ts
//
// renderTelegram — pure HudState + body → Telegram HTML.
// Three-zone layout: banner (bold emoji status) + body (raw HTML, fence
// code preserved) + footer (<blockquote expandable> with HUD metrics).
// Footer collapses to first line (turn header) by default.

import type { HudState } from '../hud/state.js';
import { escapeHtml } from '../util/html.js';
import { markdownToTelegramHtml } from './markdown.js';

export interface TelegramRender { html: string; }

const HR_BAR = '▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰';
const BAR_WIDTH = 10;

function bar(pct: number): string {
  const safe = Number.isFinite(pct) ? pct : 0;
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((safe / 100) * BAR_WIDTH)));
  return '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function fmtDur(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }
function fmtCost(n: number): string { return `$${n.toFixed(2)}`; }
function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function banner(state: HudState): string {
  if (state.isErrored) return `<b>❌ error · ${escapeHtml(state.errorSummary ?? '')}</b>`;
  if (state.isFrozen) return `<b>✓ done</b>`;
  if (state.askPending) return `<b>❓ awaiting input</b>`;
  const a = state.currentActivity;
  if (a?.kind === 'waiting_permission') return `<b>⏸ waiting for permission</b>`;
  if (a?.kind === 'tool_running') return `<b>◐ ${escapeHtml(a.toolName ?? 'tool')}</b>`;
  return `<b>◐ thinking</b>`;
}

function footer(state: HudState): string {
  const lines: string[] = [];
  lines.push(`📊 turn ${state.turnNumber} · ${escapeHtml(state.sessionShortId)} · ${escapeHtml(state.model)}`);
  if (state.gitBranch) lines.push(`🌳 ${escapeHtml(state.gitBranch)} · ${escapeHtml(state.workspaceName)}`);

  const ctxPct = state.modelMaxContext > 0
    ? Math.round((state.contextUsedTok / state.modelMaxContext) * 100)
    : 0;
  lines.push(`Context ${bar(ctxPct)} ${ctxPct}% (${fmtTok(state.contextUsedTok)}/${fmtTok(state.modelMaxContext)})`);

  for (const q of state.quotaBars) {
    const reset = q.resetsIn ? ` (${escapeHtml(q.resetsIn)})` : '';
    lines.push(`${escapeHtml(q.label)} ${bar(q.pct)} ${q.pct}%${reset}`);
  }

  const a = state.currentActivity;
  if (a) {
    if (a.kind === 'tool_running') {
      const arg = a.toolArg ? ` <code>${escapeHtml(a.toolArg)}</code>` : '';
      lines.push(`◐ <b>${escapeHtml(a.toolName ?? 'tool')}</b>${arg} · ${fmtDur(a.elapsedMs)}`);
    } else if (a.kind === 'thinking') {
      lines.push(`◐ thinking · ${fmtDur(a.elapsedMs)}`);
    } else if (a.kind === 'waiting_permission') {
      lines.push(`⏸ waiting · ${escapeHtml(a.toolName ?? '')}`);
    }
  }
  if (state.toolTally.size > 0) {
    const chips: string[] = [];
    for (const [n, c] of state.toolTally) chips.push(`✓ ${escapeHtml(n)}×${c}`);
    lines.push(chips.join(' · '));
  }
  for (const t of state.todoList) {
    if (t.status === 'in_progress') lines.push(`▶ ${escapeHtml(t.text)}`);
  }
  lines.push(`⏱ ${fmtDur(state.durationMs)} · 💵 ${fmtCost(state.costThisTurn)} · Σ ${fmtCost(state.costSession)}`);

  return `<blockquote expandable>\n${lines.join('\n')}\n</blockquote>`;
}

export function renderTelegram(state: HudState, body: string): TelegramRender {
  const bodyHtml = body.trim()
    ? markdownToTelegramHtml(body)
    : '<i>thinking...</i>';
  const html = `${banner(state)}\n${HR_BAR}\n\n${bodyHtml}\n\n${footer(state)}`;
  return { html };
}
