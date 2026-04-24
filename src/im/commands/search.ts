// src/im/commands/search.ts
//
// `/search [--global] <text>` — substring search across session histories.
// Uses `session/discovery.ts` + `session/search.ts` (native jsonl readers)
// when available; gracefully falls back to a title-only scan when
// discovery is unavailable (e.g. no jsonl on disk in tests).

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';
import { discoverSessions } from '../../session/discovery.js';
import { searchSessions, type SearchHit } from '../../session/search.js';

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
    const liveIds = new Set(ctx.sessionManager.listInfo('local').map((i) => i.id));

    let hits: SearchHit[] = [];
    try {
      const listings = await discoverSessions({ liveIds });
      const filtered = workspaceFilter
        ? listings.filter((l) => (l as unknown as { workspaceId?: string }).workspaceId === workspaceFilter.id)
        : listings;
      hits = await searchSessions(filtered, { query, limit: 10 });
    } catch { /* swallow — fall through to title scan */ }

    if (hits.length === 0) {
      // Fallback: title match on live sessions.
      const needle = query.toLowerCase();
      const lines: string[] = [];
      for (const info of ctx.sessionManager.listInfo('local')) {
        if (workspaceFilter && info.workspaceId !== workspaceFilter.id) continue;
        const title = info.title?.toLowerCase() ?? '';
        if (title.includes(needle)) lines.push(`${info.shortAlias}: ${info.title}`);
      }
      if (lines.length === 0) { await ctx.reply(`No matches for '${query}'.`); return; }
      await ctx.reply([`Matches for '${query}':`, ...lines.slice(0, 10)].join('\n'));
      return;
    }
    const body = hits.slice(0, 10).map((h) => `${h.sdkSessionId.slice(0, 8)}: ${h.snippet}`).join('\n');
    await ctx.reply(`Matches for '${query}':\n${body}`);
  },
};
