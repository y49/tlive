// src/im/commands/sessions.ts
//
// `/sessions [--archived] [--global]` — paginated listing, 8 per page.

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const sessionsCmd: CommandDef = {
  name: 'sessions',
  role: ['admin', 'operator', 'observer'],
  description: 'List sessions',
  async run(ctx, args) {
    const { flags } = parseFlags(args);
    const global = flags.global === true;
    const workspaceFilter = global ? null : workspaceForChat(ctx);
    const infos = ctx.sessionManager.listInfo('local')
      .filter((s) => !workspaceFilter || s.workspaceId === workspaceFilter.id)
      .slice(0, 8); // spec: 8 per page

    if (infos.length === 0) { await ctx.reply('No live sessions.'); return; }
    const lines = infos.map((s) => {
      const cost = s.cost.totalCost.toFixed(4);
      const title = s.title ? ` — ${s.title}` : '';
      return `• ${s.shortAlias} [${s.status.phase}] $${cost}${title}`;
    });
    await ctx.reply(['Sessions:', ...lines].join('\n'));
  },
};
