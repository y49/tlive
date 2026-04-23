// src/im/commands/fork.ts
//
// `/fork <alias> [as "<title>"]` — fork a session at its current
// conversation state. Returns the new sdkSessionId.

import type { CommandDef } from '../command-parser.js';
import { parseQuoted } from './_shared.js';
import { resolveSessionArg } from './_shared.js';

export const forkCmd: CommandDef = {
  name: 'fork',
  role: ['admin', 'operator'],
  description: 'Fork a session',
  async run(ctx, args) {
    const { head, quoted } = parseQuoted(args);
    const alias = head[0];
    if (!alias) { await ctx.reply('Usage: /fork <alias> [as "<title>"]'); return; }
    const target = await resolveSessionArg(ctx, alias);
    if (!target) return;
    if (target.kind !== 'local') { await ctx.reply('Cannot fork a remote session.'); return; }
    const title = quoted ?? undefined;
    const res = await target.forkSession(title);
    await ctx.reply(`Forked ${target.shortAlias} → ${res.sdkSessionId.slice(0, 8)}${title ? ` as "${title}"` : ''}.`);
  },
};
