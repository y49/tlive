// src/im/reply-document/format-feishu.ts
//
// renderFeishu — pure HudState + body → lark card 2.0. Header.template
// renders state color natively (blue/yellow/turquoise/green/red); body
// elements are fixed order: markdown body / hr / markdown status / note cost.

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
function fmtTok(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function templateAndPrefix(state: HudState): { template: string; prefix: string } {
  if (state.isErrored) return { template: 'red', prefix: '❌' };
  if (state.isFrozen) return { template: 'green', prefix: '✓' };
  if (state.askPending) return { template: 'turquoise', prefix: '❓' };
  if (state.currentActivity?.kind === 'waiting_permission') return { template: 'yellow', prefix: '⏸' };
  return { template: 'blue', prefix: '◐' };
}

export function renderFeishu(state: HudState, body: string): FeishuRender {
  const { template, prefix } = templateAndPrefix(state);
  const subtitleParts = [state.model, state.workspaceName];
  if (state.gitBranch) subtitleParts.push(state.gitBranch);

  const status: string[] = [];
  const ctxPct = state.modelMaxContext > 0
    ? Math.round((state.contextUsedTok / state.modelMaxContext) * 100) : 0;
  status.push(`**Context** ${bar(ctxPct)} ${ctxPct}% (${fmtTok(state.contextUsedTok)}/${fmtTok(state.modelMaxContext)})`);
  for (const q of state.quotaBars) {
    const reset = q.resetsIn ? ` (${q.resetsIn})` : '';
    status.push(`**${q.label}** ${bar(q.pct)} ${q.pct}%${reset}`);
  }
  const a = state.currentActivity;
  if (a?.kind === 'tool_running') {
    const arg = a.toolArg ? ` · ${a.toolArg}` : '';
    status.push(`<font color='orange'>◐ ${a.toolName}${arg} · ${fmtDur(a.elapsedMs)}</font>`);
  } else if (a?.kind === 'thinking') {
    status.push(`<font color='grey'>◐ thinking · ${fmtDur(a.elapsedMs)}</font>`);
  } else if (a?.kind === 'waiting_permission') {
    status.push(`<font color='yellow'>⏸ ${a.toolName ?? ''}</font>`);
  }
  if (state.toolTally.size > 0) {
    const chips: string[] = [];
    for (const [n, c] of state.toolTally) chips.push(`✓ ${n}×${c}`);
    status.push(chips.join(' · '));
  }
  for (const t of state.todoList) {
    if (t.status === 'in_progress') status.push(`▶ ${t.text}`);
  }

  const card = {
    schema: '2.0',
    header: {
      template,
      title: { tag: 'plain_text', content: `${prefix} turn ${state.turnNumber} · ${state.sessionShortId}` },
      subtitle: { tag: 'plain_text', content: subtitleParts.join(' · ') },
    },
    body: {
      elements: [
        { tag: 'markdown', content: body.trim() ? body : '_thinking…_' },
        { tag: 'hr' },
        { tag: 'markdown', content: status.join('\n') },
        { tag: 'note', elements: [{
          tag: 'plain_text',
          content: `⏱ ${fmtDur(state.durationMs)} · 💵 ${fmtCost(state.costThisTurn)} · Σ ${fmtCost(state.costSession)}`,
        }] },
      ],
    },
  };
  return { card };
}
