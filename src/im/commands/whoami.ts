// src/im/commands/whoami.ts
//
// `/whoami` — report the caller's user id + role + bound workspace.
// When the chat is unbound, also point at /bind so onboarding has an
// explicit next step from inside IM.

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

    const lines: string[] = [
      `You are ${who} · role: ${role} · workspace: ${wsLabel}`,
    ];

    if (!ws) {
      const all = ctx.workspaceManager.list();
      const myAdmin = all.filter(
        (w) => ctx.workspaceManager.getRole(w.id, ctx.userId) === 'admin',
      );
      lines.push('');
      lines.push(`This chat (${ctx.inbound.channelType}:${ctx.inbound.chatId}) is not bound to a workspace.`);
      if (all.length > 0) {
        lines.push(`Available workspaces: ${all.map((w) => w.name).join(', ')}`);
      }
      if (myAdmin.length > 0) {
        lines.push(`You're admin of: ${myAdmin.map((w) => w.name).join(', ')}`);
        lines.push('Use `/bind` to attach this chat.');
      } else {
        lines.push('Use `/bind <name>` to attach (admin only).');
      }
    }

    await ctx.reply(lines.join('\n'));
  },
};
