// src/im/commands/revoke.ts
//
// `/revoke <user>` — revoke all explicit role grants for a user. The user
// falls back to the workspace's `defaultRole`.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const revokeCmd: CommandDef = {
  name: 'revoke',
  role: ['admin'],
  description: 'Revoke a user',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    const userRaw = args[0];
    if (!userRaw) { await ctx.reply('Usage: /revoke <user>'); return; }
    const userId = userRaw.replace(/^@/, '');
    if (userId in ws.roles) {
      delete ws.roles[userId];
      await ctx.workspaceManager.save();
      await ctx.reply(`Revoked ${userRaw}. They now fall back to default role '${ws.defaultRole}'.`);
    } else {
      await ctx.reply(`${userRaw} has no explicit role grants.`);
    }
  },
};
