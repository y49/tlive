// src/im/commands/sessions.ts
//
// `/sessions [--archived] [--global] [--page=N]` — paginated listing,
// 8 per page. Footer shows `Page N of M — /sessions --page=N+1 for more`
// when more pages exist.

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

const PAGE_SIZE = 8;

export const sessionsCmd: CommandDef = {
  name: 'sessions',
  role: ['admin', 'operator', 'observer'],
  description: 'List sessions',
  async run(ctx, args) {
    const { flags } = parseFlags(args);
    const global = flags.global === true;
    const workspaceFilter = global ? null : workspaceForChat(ctx);
    const filtered = ctx.sessionManager.listInfo('local')
      .filter((s) => !workspaceFilter || s.workspaceId === workspaceFilter.id);

    if (filtered.length === 0) { await ctx.reply('No live sessions.'); return; }

    const page = Math.max(1, Number(flags.page ?? 1) || 1);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    if (slice.length === 0) {
      await ctx.reply(`No sessions on page ${page}. Total pages: ${totalPages}.`);
      return;
    }

    const lines = slice.map((s) => {
      const cost = s.cost.totalCost.toFixed(4);
      const title = s.title ? ` — ${s.title}` : '';
      return `• ${s.shortAlias} [${s.status.phase}] $${cost}${title}`;
    });
    const footer = page < totalPages
      ? `Page ${page} of ${totalPages} — /sessions --page=${page + 1} for more`
      : `Page ${page} of ${totalPages}`;
    await ctx.reply(['Sessions:', ...lines, footer].join('\n'));
  },
};
