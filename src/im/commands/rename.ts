// src/im/commands/rename.ts
//
// `/rename <alias> "<title>"` — set the human-readable title of a session.

import type { CommandDef } from '../command-parser.js';
import { parseQuoted, resolveSessionArg } from './_shared.js';

export const renameCmd: CommandDef = {
  name: 'rename',
  role: ['admin', 'operator'],
  description: 'Rename a session',
  async run(ctx, args) {
    const { head, quoted } = parseQuoted(args);
    const alias = head[0];
    if (!alias || !quoted) { await ctx.reply('Usage: /rename <alias> "<title>"'); return; }
    const target = await resolveSessionArg(ctx, alias);
    if (!target) return;
    if (target.kind !== 'local') { await ctx.reply('Cannot rename a remote session.'); return; }
    await target.renameSession(quoted);
    await ctx.reply(`Renamed ${target.shortAlias} → "${quoted}".`);
  },
};
