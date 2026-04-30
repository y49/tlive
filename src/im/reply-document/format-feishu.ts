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

function fmtCostForFeishu(n: number, isFinal: boolean): string {
  if (!isFinal) return '💵 –.--';
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
  // Always-visible time + cost anchors (live elapsed; cost shown only when final)
  const isFinal = state.isFrozen || state.isErrored;
  parts.push(`⏱ ${fmtDur(elapsedMsForRender(state, now))} · ${fmtCostForFeishu(state.costThisTurn, isFinal)}`);
  return parts.join('\n');
}

function detailMarkdown(state: HudState): string {
  const lines: string[] = [];
  const maxK = fmtTok(state.modelMaxContext);
  lines.push(`💬 #${state.turnNumber} · ${state.sessionShortId} · ${state.model} (${maxK})`);
  if (state.gitBranch) lines.push(`🌳 ${state.gitBranch} · ${state.workspaceName}`);
  const ctxPct = state.modelMaxContext > 0
    ? Math.round((state.contextUsedTok / state.modelMaxContext) * 100) : 0;
  lines.push(`**Context** ${bar(ctxPct)} ${ctxPct}% (${fmtTok(state.contextUsedTok)}/${maxK})`);
  for (const q of state.quotaBars) {
    const reset = q.resetsIn ? ` (${q.resetsIn})` : '';
    lines.push(`**${q.label}** ${bar(q.pct)} ${q.pct}%${reset}`);
  }
  lines.push(`Σ ${fmtCost(state.costSession)}`);
  return lines.join('\n');
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
      ],
    },
  };
  return { card };
}
