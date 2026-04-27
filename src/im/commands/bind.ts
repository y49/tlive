// src/im/commands/bind.ts
//
// `/bind [<workspace-name>]` — bind the current chat to a workspace.
// Used as the explicit onboarding step when bootstrap auto-bind didn't
// catch the chat (no chatId in config, or admin chose late binding).

import type { CommandDef } from '../command-parser.js';

export const bindCmd: CommandDef = {
  name: 'bind',
  // Intentionally allow any role at the dispatch gate, because /bind is
  // typically invoked from an *unbound* chat, where dispatch defaults the
  // caller's role to 'observer' (no workspace to look up roles in). The
  // command's own logic enforces authorization via `myAdminWs.length > 0`
  // — only users with admin role on at least one workspace can actually
  // bind. Non-admins get a friendly, non-revealing error.
  role: ['admin', 'operator', 'observer'],
  description: 'Bind this chat to a workspace (admin only — enforced internally)',
  async run(ctx, args) {
    const target = args[0];

    // Find workspaces this user admins.
    const myAdminWs = ctx.workspaceManager.list().filter(
      (w) => ctx.workspaceManager.getRole(w.id, ctx.userId) === 'admin',
    );

    let ws;
    if (target) {
      ws = myAdminWs.find((w) => w.name === target);
      if (!ws) {
        const names = myAdminWs.map((w) => w.name).join(', ') || '(none)';
        await ctx.reply(
          `No workspace named "${target}" or you're not its admin. ` +
          `Your admin workspaces: ${names}`,
        );
        return;
      }
    } else {
      if (myAdminWs.length === 0) {
        await ctx.reply(
          'You are not admin of any workspace. ' +
          'Set workspaces[].adminUserId in ~/.tlive/config.json and restart, ' +
          'or have an existing admin run `/grant <your-id> admin` first.',
        );
        return;
      }
      if (myAdminWs.length > 1) {
        const names = myAdminWs.map((w) => w.name).join(', ');
        await ctx.reply(
          `You admin multiple workspaces: ${names}. Use \`/bind <name>\`.`,
        );
        return;
      }
      ws = myAdminWs[0]!;
    }

    // Idempotency / cross-workspace guard.
    const existing = ctx.workspaceManager.findByChat(
      ctx.inbound.channelType, ctx.inbound.chatId,
    );
    if (existing && existing.id === ws.id) {
      await ctx.reply(`Already bound to "${ws.name}".`);
      return;
    }
    if (existing && existing.id !== ws.id) {
      await ctx.reply(
        `This chat is already bound to "${existing.name}". ` +
        `Run \`/mirror remove\` from this chat first, then \`/bind ${ws.name}\`.`,
      );
      return;
    }

    ctx.workspaceManager.addBinding(ws.id, {
      channelType: ctx.inbound.channelType,
      chatId: ctx.inbound.chatId,
      role: 'primary',
      threadId: ctx.inbound.threadId,
    });
    await ctx.workspaceManager.save();
    await ctx.reply(
      `Bound this chat (${ctx.inbound.channelType}:${ctx.inbound.chatId}) ` +
      `to workspace "${ws.name}". Send any message to start a session.`,
    );
  },
};
