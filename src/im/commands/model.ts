// src/im/commands/model.ts
//
// `/model [<m>]` — show or change the active session's model. Persists as
// workspace default so new sessions pick it up.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession, workspaceForChat } from './_shared.js';

export const modelCmd: CommandDef = {
  name: 'model',
  role: ['admin', 'operator'],
  description: 'Show or change model',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    if (args.length === 0) {
      await ctx.reply(`Current model: ${ws.defaults.model ?? 'default'}`);
      return;
    }
    const newModel = args[0]!;
    ws.defaults.model = newModel;
    await ctx.workspaceManager.save();
    const session = await activeLocalSession(ctx).catch(() => null);
    if (session) await session.setModel(newModel);
    await ctx.reply(`Model set to ${newModel}.`);
  },
};
