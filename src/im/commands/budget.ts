// src/im/commands/budget.ts
//
// `/budget [<usd>]` — show or cap the workspace's daily budget.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const budgetCmd: CommandDef = {
  name: 'budget',
  role: ['admin', 'operator'],
  description: 'Show or set daily budget',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    if (args.length === 0) {
      const daily = ws.budget.dailyUsd;
      await ctx.reply(`Daily budget: ${daily !== undefined ? `$${daily.toFixed(2)}` : '(unset)'}`);
      return;
    }
    const usd = Number(args[0]);
    if (!Number.isFinite(usd) || usd < 0) { await ctx.reply('Usage: /budget <usd>'); return; }
    ws.budget.dailyUsd = usd;
    await ctx.workspaceManager.save();
    await ctx.reply(`Daily budget set to $${usd.toFixed(2)}.`);
  },
};
