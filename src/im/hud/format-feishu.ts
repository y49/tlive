// src/im/hud/format-feishu.ts
//
// buildFeishuHudCard — pure HudState -> lark card 2.0 payload. The element
// shape follows Lark's interactive-card 2.0 schema; @larksuiteoapi/node-sdk
// accepts this object directly as the message body.

import type { HudState } from './state.js';

export interface LarkCardV2 {
  schema: '2.0';
  header: {
    title: { content: string; tag: 'plain_text' };
    template: 'blue' | 'grey' | 'red';
  };
  body: {
    elements: ReadonlyArray<unknown>;
  };
}

function pickTemplate(state: HudState): 'blue' | 'grey' | 'red' {
  if (state.isErrored) return 'red';
  if (state.isFrozen) return 'grey';
  return 'blue';
}

export function buildFeishuHudCard(state: HudState): LarkCardV2 {
  const elements: unknown[] = [];

  const branch = state.gitBranch ? ` · ${state.gitBranch}` : '';
  elements.push({
    tag: 'markdown',
    content: `**${state.model}** [${state.provider}] · ${state.workspaceName}${branch}`,
  });
  elements.push({ tag: 'hr' });

  const ctxPct = state.modelMaxContext > 0
    ? Math.round((state.contextUsedTok / state.modelMaxContext) * 100)
    : 0;
  elements.push({ tag: 'progress_bar', label: 'Context', percent: ctxPct });

  for (const q of state.quotaBars) {
    elements.push({
      tag: 'progress_bar',
      label: q.label,
      percent: q.pct,
      ...(q.resetsIn ? { hint: q.resetsIn } : {}),
    });
  }

  if (state.currentActivity) {
    const a = state.currentActivity;
    let line = '';
    if (a.kind === 'thinking') {
      line = `◐ thinking · ${(a.elapsedMs / 1000).toFixed(1)}s`;
    } else if (a.kind === 'tool_running') {
      const arg = a.toolArg ? ` · ${a.toolArg}` : '';
      line = `◐ ${a.toolName ?? 'tool'}${arg} · ${(a.elapsedMs / 1000).toFixed(1)}s`;
    } else {
      line = `⏸ waiting for permission${a.toolName ? ` · ${a.toolName}` : ''}`;
    }
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `<font color="orange">${line}</font>` });
  }

  if (state.toolTally.size > 0) {
    const chips: string[] = [];
    for (const [name, count] of state.toolTally) chips.push(`✓ ${name} ×${count}`);
    elements.push({ tag: 'markdown', content: chips.join('  ') });
  }

  if (state.subagents.length > 0) {
    elements.push({ tag: 'hr' });
    for (const sa of state.subagents) {
      const icon = sa.status === 'running' ? '◐' : sa.status === 'done_ok' ? '✓' : '✗';
      const model = sa.model ? ` [${sa.model}]` : '';
      const summary = sa.summary ? ` — ${sa.summary}` : '';
      elements.push({ tag: 'markdown', content: `${icon} **${sa.name}**${model}${summary}` });
    }
  }

  if (state.todoList.length > 0) {
    elements.push({ tag: 'hr' });
    for (const t of state.todoList) {
      const mark = t.status === 'done' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
      elements.push({ tag: 'markdown', content: `${mark} ${t.text}` });
    }
  }

  if (state.isErrored && state.errorSummary) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `❌ **${state.errorSummary}**` });
  }

  elements.push({
    tag: 'note',
    elements: [{
      tag: 'plain_text',
      content: `$${state.costThisTurn.toFixed(2)} · ${(state.durationMs / 1000).toFixed(1)}s · Σ $${state.costSession.toFixed(2)}`,
    }],
  });

  return {
    schema: '2.0',
    header: {
      title: { content: `📊 turn ${state.turnNumber} · ${state.sessionShortId}`, tag: 'plain_text' },
      template: pickTemplate(state),
    },
    body: { elements },
  };
}
