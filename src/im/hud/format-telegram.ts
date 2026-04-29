// src/im/hud/format-telegram.ts
//
// formatTelegramHud — pure HudState -> HTML string. The output goes inside
// <pre><code>...</code></pre> so Telegram renders monospace, ignores
// embedded markdown, and gives a stable visual block. All dynamic content
// is HTML-escaped to avoid parse-entity 400s.

import type { HudState } from './state.js';

const BAR_WIDTH = 10;

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bar(pct: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)));
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
    `📊 turn ${state.turnNumber} · ${escape(state.sessionShortId)} [${escape(state.provider)}]${headerSuffix}`,
  );

  const branch = state.gitBranch ? ` · ${escape(state.gitBranch)}` : '';
  lines.push(`${escape(state.model)} · ${escape(state.workspaceName)}${branch}`);
  lines.push('');

  const ctxPct = state.modelMaxContext > 0
    ? Math.round((state.contextUsedTok / state.modelMaxContext) * 100)
    : 0;
  lines.push(`Context  ${bar(ctxPct)} ${ctxPct}%`);

  for (const q of state.quotaBars) {
    const reset = q.resetsIn ? ` (${escape(q.resetsIn)})` : '';
    lines.push(`${escape(q.label.padEnd(8))}${bar(q.pct)} ${q.pct}%${reset}`);
  }
  lines.push('');

  if (state.currentActivity) {
    const a = state.currentActivity;
    if (a.kind === 'thinking') {
      lines.push(`◐ thinking · ${fmtElapsed(a.elapsedMs)}`);
    } else if (a.kind === 'tool_running') {
      const argPart = a.toolArg ? ` · ${escape(a.toolArg)}` : '';
      lines.push(`◐ ${escape(a.toolName ?? 'tool')}${argPart} · ${fmtElapsed(a.elapsedMs)}`);
    } else if (a.kind === 'waiting_permission') {
      lines.push(`⏸ waiting for permission · ${escape(a.toolName ?? '')}`);
    }
  }

  if (state.toolTally.size > 0) {
    const chips: string[] = [];
    for (const [name, count] of state.toolTally) {
      chips.push(`✓ ${escape(name)} ×${count}`);
    }
    lines.push(chips.join('  '));
  }

  if (state.subagents.length > 0) {
    lines.push('');
    for (const sa of state.subagents) {
      const icon = sa.status === 'running' ? '◐' : sa.status === 'done_ok' ? '✓' : '✗';
      const model = sa.model ? ` [${escape(sa.model)}]` : '';
      lines.push(`${icon} ${escape(sa.name)}${model}`);
      if (sa.summary) lines.push(`  ${escape(sa.summary)}`);
    }
  }

  if (state.todoList.length > 0) {
    lines.push('');
    for (const t of state.todoList) {
      const mark = t.status === 'done' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
      lines.push(`${mark} ${escape(t.text)}`);
    }
  }

  lines.push('');
  lines.push(
    `${fmtCost(state.costThisTurn)} · ${fmtDuration(state.durationMs)} · Σ ${fmtCost(state.costSession)}`,
  );

  if (state.isErrored && state.errorSummary) {
    lines.push('');
    lines.push(`❌ ${escape(state.errorSummary)}`);
  }

  return `<pre><code>${lines.join('\n')}</code></pre>`;
}
