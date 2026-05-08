// src/im/commands/cost.ts
//
// /cost [today|week|month|total] [--all] — cost dashboard scoped to
// current workspace by default. Alias --global preserved.

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';
import { buildDashboard } from '../../cost/dashboard.js';
import { workspaceForChat } from './_shared.js';

const RANGE_MS: Record<string, number> = {
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export const costCmd: CommandDef = {
  name: 'cost',
  description: '工作区累计成本',
  async run(ctx, args) {
    const { flags, positional } = parseFlags(args);
    const range = (positional[0] ?? 'today') as 'today' | 'week' | 'month' | 'total';
    const allScope = flags.all === true || flags.global === true;
    const ws = allScope ? null : workspaceForChat(ctx);

    if (!allScope && !ws) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个,或用 /cost --all');
      return;
    }

    const since = range === 'total' ? 0 : Date.now() - (RANGE_MS[range] ?? RANGE_MS.today);
    const scopeLabel = allScope ? '所有工作区' : (ws?.name ?? '?');

    if (!ctx.rollupStore) {
      const infos = ctx.sessionManager.listInfo('local').filter((s) => !ws || s.workspaceId === ws.id);
      const total = infos.reduce((sum, s) => sum + s.cost.totalCost, 0);
      await ctx.reply(`💰 ${scopeLabel} (${range}): $${total.toFixed(4)}\n   ${infos.length} live sessions`);
      return;
    }

    const deltas = await ctx.rollupStore.load();
    const dash = buildDashboard(deltas, { sinceMs: since, workspaceId: ws?.id });
    const lines = [`💰 ${scopeLabel} (${range}): $${dash.grandTotalUsd.toFixed(4)}`];
    for (const w of dash.workspaces.slice(0, 5)) {
      lines.push(`   • ${w.workspaceId.slice(0, 8)}: $${w.totalUsd.toFixed(4)} (${w.sessions} sessions)`);
    }
    await ctx.reply(lines.join('\n'));
  },
};
