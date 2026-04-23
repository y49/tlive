// src/im/commands/thinking.ts
//
// `/thinking [collapsed|expanded|hidden]` — how to render reasoning.

import type { CommandDef } from '../command-parser.js';
import type { ThinkingLevel } from '../../runtime/types.js';
import { workspaceForChat } from './_shared.js';

const VALID: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>(['collapsed', 'expanded', 'hidden']);

export const thinkingCmd: CommandDef = {
  name: 'thinking',
  role: ['admin', 'operator'],
  description: 'Thinking visibility',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    if (args.length === 0) {
      await ctx.reply(`Current thinking: ${ws.defaults.thinking}`);
      return;
    }
    const level = args[0] as ThinkingLevel;
    if (!VALID.has(level)) {
      await ctx.reply(`Invalid '${level}'. Valid: collapsed, expanded, hidden`);
      return;
    }
    ws.defaults.thinking = level;
    await ctx.workspaceManager.save();
    await ctx.reply(`Thinking set to ${level}.`);
  },
};
