// src/im/commands/whoami.ts
//
// `/whoami` — report the caller's user id + role + bound workspace.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const whoamiCmd: CommandDef = {
  name: 'whoami',
  role: ['admin', 'operator', 'observer'],
  description: 'Show your identity + role',
  async run(ctx) {
    const ws = workspaceForChat(ctx);
    const role = ws ? ctx.workspaceManager.getRole(ws.id, ctx.userId) : 'observer';
    const who = ctx.inbound.username ? `@${ctx.inbound.username}` : ctx.userId;
    const wsLabel = ws ? `${ws.name} (${ws.id.slice(0, 8)})` : '(none)';
    await ctx.reply(`You are ${who} · role: ${role} · workspace: ${wsLabel}`);
  },
};
