// src/im/commands/effort.ts
//
// `/effort [low|medium|high|max]` — show or change reasoning effort level.

import type { CommandDef } from '../command-parser.js';
import type { Effort } from '../../runtime/types.js';
import { workspaceForChat } from './_shared.js';

const VALID: ReadonlySet<Effort> = new Set<Effort>(['low', 'medium', 'high', 'max']);

export const effortCmd: CommandDef = {
  name: 'effort',
  role: ['admin', 'operator'],
  description: 'Show or change reasoning effort',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    if (args.length === 0) {
      await ctx.reply(`Current effort: ${ws.defaults.effort ?? 'default'}`);
      return;
    }
    const level = args[0] as Effort;
    if (!VALID.has(level)) {
      await ctx.reply(`Invalid effort '${level}'. Valid: low, medium, high, max`);
      return;
    }
    ws.defaults.effort = level;
    await ctx.workspaceManager.save();
    await ctx.reply(`Effort set to ${level}. Applies from next turn.`);
  },
};
