// src/im/commands/mirror.ts
//
// `/mirror [add primary|add mirror|remove|list]` — manage multi-chat
// bindings. The "add" variants use the current chat as the target.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';
import type { ChatBinding } from '../../workspace/bindings.js';

export const mirrorCmd: CommandDef = {
  name: 'mirror',
  role: ['admin'],
  description: 'Manage multi-chat bindings',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    const sub = args[0] ?? 'list';

    if (sub === 'list') {
      if (ws.bindings.length === 0) { await ctx.reply('(no bindings)'); return; }
      const lines = ws.bindings.map((b) => `• [${b.role}] ${b.channelType}:${b.chatId}`);
      await ctx.reply(['Mirror bindings:', ...lines].join('\n'));
      return;
    }
    if (sub === 'add') {
      const role = args[1] as 'primary' | 'mirror';
      if (role !== 'primary' && role !== 'mirror') {
        await ctx.reply('Usage: /mirror add primary|mirror'); return;
      }
      const binding: ChatBinding = {
        channelType: ctx.inbound.channelType,
        chatId: ctx.inbound.chatId,
        role,
        threadId: ctx.inbound.threadId,
      };
      ctx.workspaceManager.addBinding(ws.id, binding);
      await ctx.workspaceManager.save();
      await ctx.reply(`Added ${role} binding for ${binding.channelType}:${binding.chatId}.`);
      return;
    }
    if (sub === 'remove') {
      ctx.workspaceManager.removeBinding(ws.id, {
        channelType: ctx.inbound.channelType,
        chatId: ctx.inbound.chatId,
      });
      await ctx.workspaceManager.save();
      await ctx.reply('Binding removed.');
      return;
    }
    await ctx.reply('Usage: /mirror [add primary|add mirror|remove|list]');
  },
};
