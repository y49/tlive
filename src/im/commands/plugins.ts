// src/im/commands/plugins.ts
//
// `/plugins [list|enable <n>|disable <n>|reload]` — plugin management.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const pluginsCmd: CommandDef = {
  name: 'plugins',
  role: ['admin', 'operator'],
  description: 'Manage plugins',
  async run(ctx, args) {
    const sub = args[0] ?? 'list';
    const session = await activeLocalSession(ctx);
    if (!session) return;
    if (sub === 'list') {
      await ctx.reply('Plugin listing not yet exposed by runtime (TODO T9).');
      return;
    }
    if (sub === 'reload') {
      await session.reloadPlugins();
      await ctx.reply('Plugins reloaded.');
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      await ctx.reply(`Plugin ${sub}: runtime does not expose per-plugin toggle yet (TODO T9).`);
      return;
    }
    await ctx.reply('Usage: /plugins [list|enable <n>|disable <n>|reload]');
  },
};
