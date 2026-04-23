// src/im/commands/cost.ts
//
// `/cost [today|week|month] [--global]` — show cost dashboard.

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';
import { buildDashboard } from '../../cost/dashboard.js';
import { workspaceForChat } from './_shared.js';

const RANGE_MS = {
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export const costCmd: CommandDef = {
  name: 'cost',
  role: ['admin', 'operator', 'observer'],
  description: 'Show cost dashboard',
  async run(ctx, args) {
    const { flags, positional } = parseFlags(args);
    const range = (positional[0] ?? 'today') as 'today' | 'week' | 'month';
    const rangeMs = RANGE_MS[range] ?? RANGE_MS.today;
    const since = Date.now() - rangeMs;
    const global = flags.global === true;
    const ws = global ? null : workspaceForChat(ctx);

    if (!ctx.rollupStore) {
      // Live-only fallback when no persistent rollup is wired.
      const infos = ctx.sessionManager.listInfo('local')
        .filter((s) => !ws || s.workspaceId === ws.id);
      const total = infos.reduce((sum, s) => sum + s.cost.totalCost, 0);
      await ctx.reply(`Cost (${range}): $${total.toFixed(4)} across ${infos.length} live sessions.`);
      return;
    }

    const deltas = await ctx.rollupStore.load();
    const dash = buildDashboard(deltas, { sinceMs: since, workspaceId: ws?.id });
    const lines = [`Cost ${range}${global ? ' (global)' : ''}: $${dash.grandTotalUsd.toFixed(4)}`];
    for (const w of dash.workspaces.slice(0, 5)) {
      lines.push(`• ${w.workspaceId.slice(0, 8)}: $${w.totalUsd.toFixed(4)} (${w.sessions} sessions)`);
    }
    await ctx.reply(lines.join('\n'));
  },
};
