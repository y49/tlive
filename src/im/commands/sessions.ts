// src/im/commands/sessions.ts
//
// /sessions [--all] [--archived] [--page=N] — paginated session list.
// Default scope = current workspace; --all (alias --global) for cross-ws.

import type { CommandDef } from '../command-parser.js';
import type { InlineButton } from '../../platform/types.js';
import { parseFlags } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

const PAGE_SIZE = 8;

export const sessionsCmd: CommandDef = {
  name: 'sessions',
  role: ['admin', 'operator', 'observer'],
  description: '当前工作区的会话列表',
  async run(ctx, args) {
    const { flags } = parseFlags(args);
    // --all / --global both opt out of workspace filter
    const allScope = flags.all === true || flags.global === true;
    const wsFilter = allScope ? null : workspaceForChat(ctx);

    if (!allScope && !wsFilter) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个,或用 /sessions --all 看全部');
      return;
    }

    const filtered = ctx.sessionManager.listInfo('local')
      .filter((s) => !wsFilter || s.workspaceId === wsFilter.id);

    if (filtered.length === 0) {
      const scope = allScope ? '所有工作区' : `工作区 ${wsFilter!.name}`;
      await ctx.reply(`📋 ${scope} 暂无会话`, {
        replyMarkup: {
          type: 'inline_keyboard',
          buttons: [[{ text: '🆕 新会话', callbackData: 'session:new' }]],
        },
      });
      return;
    }

    const page = Math.max(1, Number(flags.page ?? 1) || 1);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const lines: string[] = [];
    const buttons: InlineButton[][] = [];
    if (allScope) lines.push(`📋 所有工作区 (${filtered.length} sessions)`);
    else lines.push(`📋 ${wsFilter!.name} (${filtered.length} sessions)`);

    for (const s of slice) {
      const cost = s.cost.totalCost.toFixed(4);
      const title = s.title ? ` — ${s.title}` : '';
      lines.push(`• ${s.shortAlias} [${s.status.phase}] $${cost}${title}`);
      buttons.push([
        { text: `▶ ${s.shortAlias}`, callbackData: `session:resume:${s.shortAlias}` },
        { text: '详情', callbackData: `session:details:${s.shortAlias}` },
      ]);
    }
    if (page < totalPages) {
      lines.push(`Page ${page}/${totalPages} — /sessions --page=${page + 1} for more`);
    } else if (totalPages > 1) {
      lines.push(`Page ${page}/${totalPages}`);
    }
    buttons.push([{ text: '🆕 新会话', callbackData: 'session:new' }]);

    await ctx.reply(lines.join('\n'), {
      replyMarkup: { type: 'inline_keyboard', buttons },
    });
  },
};
