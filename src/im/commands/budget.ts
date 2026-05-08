// src/im/commands/budget.ts
//
// /budget [<usd>|unlimited] — show or set the SESSION-level budget cap.
// Per spec §6.2 — workspace.budget.dailyUsd is intentionally unwired.
// We mutate session.maxBudgetUsd via setMaxBudget(); BudgetGuard checks
// this on every turn_end and emits runtime_error('budget_exceeded') so
// the override-button flow can react.

import type { CommandDef } from '../command-parser.js';
import type { ReplyMarkup } from '../../platform/types.js';
import { activeLocalSession } from './_shared.js';

export const budgetCmd: CommandDef = {
  name: 'budget',
  description: '当前 session 预算上限',
  async run(ctx, args) {
    const session = await activeLocalSession(ctx);
    if (!session) return;

    if (args.length === 0) {
      const cap = session.getMaxBudget();
      const used = session.cost.totalCost;
      const remaining = cap !== undefined ? Math.max(0, cap - used) : undefined;
      const lines = [
        '💰 当前会话预算',
        `   已用: $${used.toFixed(4)}`,
        `   上限: ${cap !== undefined ? `$${cap.toFixed(2)}` : '无限'}`,
      ];
      if (remaining !== undefined) lines.push(`   剩余: $${remaining.toFixed(2)}`);
      await ctx.reply(lines.join('\n'), { replyMarkup: budgetButtons() });
      return;
    }

    const arg = args[0]!.toLowerCase();
    if (arg === 'unlimited' || arg === 'off' || arg === 'none' || arg === '∞') {
      session.setMaxBudget(undefined);
      await ctx.reply('💸 预算上限: 无限');
      return;
    }
    const usd = Number(arg);
    if (!Number.isFinite(usd) || usd < 0) {
      await ctx.reply('用法: /budget <usd> 或 /budget unlimited');
      return;
    }
    session.setMaxBudget(usd);
    await ctx.reply(`💸 预算上限: $${usd.toFixed(2)}`);
  },
};

function budgetButtons(): ReplyMarkup {
  return {
    type: 'inline_keyboard',
    buttons: [
      [
        { text: '$1', callbackData: 'runtime:budget:set:1' },
        { text: '$5', callbackData: 'runtime:budget:set:5' },
        { text: '$20', callbackData: 'runtime:budget:set:20' },
      ],
      [
        { text: '$100', callbackData: 'runtime:budget:set:100' },
        { text: '$200', callbackData: 'runtime:budget:set:200' },
        { text: '无限', callbackData: 'runtime:budget:set:unlimited' },
      ],
    ],
  };
}
// Note: custom budget amounts can be set via /budget <usd> (text command).
