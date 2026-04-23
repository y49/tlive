// src/im/commands/verbose.ts
//
// `/verbose [0|1]` — toggle verbose output (tool calls + streaming).

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const verboseCmd: CommandDef = {
  name: 'verbose',
  role: ['admin', 'operator'],
  description: 'Toggle verbose output',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    if (args.length === 0) {
      await ctx.reply(`Verbose: ${ws.defaults.verbose ? 'on' : 'off'}`);
      return;
    }
    const val = args[0];
    if (val !== '0' && val !== '1') { await ctx.reply('Usage: /verbose [0|1]'); return; }
    ws.defaults.verbose = val === '1';
    await ctx.workspaceManager.save();
    await ctx.reply(`Verbose ${ws.defaults.verbose ? 'on' : 'off'}.`);
  },
};
