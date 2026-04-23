// src/im/commands/grant.ts
//
// `/grant <user> <admin|operator|observer>` — set a user's role in the
// current workspace.

import type { CommandDef } from '../command-parser.js';
import type { Role } from '../../permission/roles.js';
import { workspaceForChat } from './_shared.js';

const VALID: ReadonlySet<Role> = new Set<Role>(['admin', 'operator', 'observer']);

export const grantCmd: CommandDef = {
  name: 'grant',
  role: ['admin'],
  description: 'Grant a role to a user',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    const [userRaw, roleRaw] = args;
    if (!userRaw || !roleRaw) { await ctx.reply('Usage: /grant <user> <admin|operator|observer>'); return; }
    if (!VALID.has(roleRaw as Role)) {
      await ctx.reply(`Invalid role '${roleRaw}'.`); return;
    }
    // Accept both raw ids and @handles.
    const userId = userRaw.replace(/^@/, '');
    ctx.workspaceManager.setRole(ws.id, userId, roleRaw as Role);
    await ctx.workspaceManager.save();
    await ctx.reply(`Granted ${roleRaw} to ${userRaw}.`);
  },
};
