// src/im/commands/companion.ts
//
// `/companion [status|accept <agent>|reject <remoteId>]` — companion-mode
// federation controls. T7 provides the surface; actual state lives in the
// MCP federation layer (T5).

import type { CommandDef } from '../command-parser.js';

export const companionCmd: CommandDef = {
  name: 'companion',
  role: ['admin'],
  description: 'Manage companion-mode federation',
  async run(ctx, args) {
    const sub = args[0] ?? 'status';
    if (sub === 'status') {
      await ctx.reply('Companion status: disabled (TODO T9 — wire federation state).');
      return;
    }
    if (sub === 'accept') {
      const agent = args[1];
      if (!agent) { await ctx.reply('Usage: /companion accept <agent>'); return; }
      await ctx.reply(`Companion ${agent} accepted. (TODO T9)`);
      return;
    }
    if (sub === 'reject') {
      const remoteId = args[1];
      if (!remoteId) { await ctx.reply('Usage: /companion reject <remoteId>'); return; }
      await ctx.reply(`Companion ${remoteId} rejected. (TODO T9)`);
      return;
    }
    await ctx.reply('Usage: /companion [status|accept <agent>|reject <remoteId>]');
  },
};
