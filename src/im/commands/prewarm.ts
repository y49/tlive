// src/im/commands/prewarm.ts
//
// `/prewarm [on|off]` — toggle pre-warm of the SDK prompt cache.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const prewarmCmd: CommandDef = {
  name: 'prewarm',
  role: ['admin', 'operator'],
  description: 'Toggle prompt-cache prewarm',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    if (args.length === 0) {
      await ctx.reply(`Prewarm: ${ws.defaults.prewarmCache ? 'on' : 'off'}`);
      return;
    }
    const val = args[0];
    if (val !== 'on' && val !== 'off') { await ctx.reply('Usage: /prewarm [on|off]'); return; }
    ws.defaults.prewarmCache = val === 'on';
    await ctx.workspaceManager.save();
    await ctx.reply(`Prewarm ${ws.defaults.prewarmCache ? 'on' : 'off'}.`);
  },
};
