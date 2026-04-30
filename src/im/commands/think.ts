// src/im/commands/think.ts
//
// `/think [collapsed|expanded|hidden]` — how to render reasoning.
// (Was `/thinking` pre-v3.3 — alias preserved for typed muscle memory.)

import type { CommandDef } from '../command-parser.js';
import type { ThinkingLevel } from '../../runtime/types.js';
import { workspaceForChat } from './_shared.js';

const VALID: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>(['collapsed', 'expanded', 'hidden']);

export const thinkCmd: CommandDef = {
  name: 'think',
  aliases: ['thinking'],
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
