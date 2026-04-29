// src/im/hud/format-telegram.ts
//
// formatTelegramHud — pure HudState -> HTML string. The output goes inside
// <pre><code>...</code></pre> so Telegram renders monospace, ignores
// embedded markdown, and gives a stable visual block. All dynamic content
// is HTML-escaped to avoid parse-entity 400s.

import type { HudState } from './state.js';
import { escapeHtml } from '../util/html.js';

const BAR_WIDTH = 10;

function bar(pct: number): string {
  const safe = Number.isFinite(pct) ? pct : 0;
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((safe / 100) * BAR_WIDTH)));
  return '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTelegramHud(state: HudState): string {
  const lines: string[] = [];

  const headerSuffix = state.isErrored
    ? ' · ❌ error'
    : state.isFrozen
      ? ' · ✓ done'
      : '';
  lines.push(
    `📊 turn ${state.turnNumber} · ${escapeHtml(state.sessionShortId)} [${escapeHtml(state.provider)}]${headerSuffix}`,
  );

  const branch = state.gitBranch ? ` · ${escapeHtml(state.gitBranch)}` : '';
  lines.push(`${escapeHtml(state.model)} · ${escapeHtml(state.workspaceName)}${branch}`);
  lines.push('');

  const ctxPct = state.modelMaxContext > 0
    ? Math.round((state.contextUsedTok / state.modelMaxContext) * 100)
    : 0;
  lines.push(`Context  ${bar(ctxPct)} ${ctxPct}%`);

  for (const q of state.quotaBars) {
    const reset = q.resetsIn ? ` (${escapeHtml(q.resetsIn)})` : '';
    lines.push(`${escapeHtml(q.label.padEnd(8))}${bar(q.pct)} ${q.pct}%${reset}`);
  }
  lines.push('');

  if (state.currentActivity) {
    const a = state.currentActivity;
    if (a.kind === 'thinking') {
      lines.push(`◐ thinking · ${fmtElapsed(a.elapsedMs)}`);
    } else if (a.kind === 'tool_running') {
      const argPart = a.toolArg ? ` · ${escapeHtml(a.toolArg)}` : '';
      lines.push(`◐ ${escapeHtml(a.toolName ?? 'tool')}${argPart} · ${fmtElapsed(a.elapsedMs)}`);
    } else if (a.kind === 'waiting_permission') {
      lines.push(`⏸ waiting for permission · ${escapeHtml(a.toolName ?? '')}`);
    }
  }

  if (state.toolTally.size > 0) {
    const chips: string[] = [];
    for (const [name, count] of state.toolTally) {
      chips.push(`✓ ${escapeHtml(name)} ×${count}`);
    }
    lines.push(chips.join('  '));
  }

  if (state.subagents.length > 0) {
    lines.push('');
    for (const sa of state.subagents) {
      const icon = sa.status === 'running' ? '◐' : sa.status === 'done_ok' ? '✓' : '✗';
      const model = sa.model ? ` [${escapeHtml(sa.model)}]` : '';
      lines.push(`${icon} ${escapeHtml(sa.name)}${model}`);
      if (sa.summary) lines.push(`  ${escapeHtml(sa.summary)}`);
    }
  }

  if (state.todoList.length > 0) {
    lines.push('');
    for (const t of state.todoList) {
      const mark = t.status === 'done' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
      lines.push(`${mark} ${escapeHtml(t.text)}`);
    }
  }

  lines.push('');
  lines.push(
    `${fmtCost(state.costThisTurn)} · ${fmtDuration(state.durationMs)} · Σ ${fmtCost(state.costSession)}`,
  );

  if (state.isErrored && state.errorSummary) {
    lines.push('');
    lines.push(`❌ ${escapeHtml(state.errorSummary)}`);
  }

  return `<pre><code>${lines.join('\n')}</code></pre>`;
}
