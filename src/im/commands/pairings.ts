// src/im/commands/pairings.ts
//
// `/pairings` — list all chat bindings for the current workspace.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const pairingsCmd: CommandDef = {
  name: 'pairings',
  role: ['admin', 'operator', 'observer'],
  description: 'List chat bindings',
  async run(ctx) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    if (ws.bindings.length === 0) { await ctx.reply('No chat bindings.'); return; }
    const lines = ws.bindings.map((b) => `• [${b.role}] ${b.channelType}:${b.chatId}${b.threadId ? `/${b.threadId}` : ''}`);
    await ctx.reply(['Pairings:', ...lines].join('\n'));
  },
};
