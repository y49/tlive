// src/im/commands/search.ts
//
// `/search [--global] <text>` — substring search across session jsonls.
// TODO(T9): wire the real discovery + searchSessions into ctx. For now
// report a stub listing of currently-live sessions whose recent history
// contains the query.

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const searchCmd: CommandDef = {
  name: 'search',
  role: ['admin', 'operator', 'observer'],
  description: 'Search messages',
  async run(ctx, args) {
    const { flags, positional } = parseFlags(args);
    const query = positional.join(' ').trim();
    if (!query) { await ctx.reply('Usage: /search <text> [--global]'); return; }

    const global = flags.global === true;
    const workspaceFilter = global ? null : workspaceForChat(ctx);
    const needle = query.toLowerCase();
    const hits: string[] = [];
    for (const info of ctx.sessionManager.listInfo('local')) {
      if (workspaceFilter && info.workspaceId !== workspaceFilter.id) continue;
      const title = info.title?.toLowerCase() ?? '';
      if (title.includes(needle)) hits.push(`${info.shortAlias}: ${info.title}`);
    }
    if (hits.length === 0) { await ctx.reply(`No matches for '${query}'.`); return; }
    await ctx.reply([`Matches for '${query}':`, ...hits.slice(0, 10)].join('\n'));
  },
};
