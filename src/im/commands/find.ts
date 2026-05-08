// src/im/commands/find.ts
//
// /find <keyword> — search current workspace's jsonl conversation history.
// Aliases ['search'] — replaces the deleted /search command.
//
// Implementation: workdir-scoped jsonl scan via discovery + search modules.
// Workspace filter narrows discovery results to listings whose workdir
// matches the bound workspace's workdir.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';
import { discoverSessions } from '../../session/discovery.js';
import { searchSessions, type SearchHit } from '../../session/search.js';

export const findCmd: CommandDef = {
  name: 'find',
  aliases: ['search'],
  description: '搜索当前工作区会话历史',
  async run(ctx, args) {
    if (args.length === 0) {
      await ctx.reply('用法: /find <关键词>\n例: /find OAuth\n搜索当前工作区所有会话历史');
      return;
    }
    const ws = workspaceForChat(ctx);
    if (!ws) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个');
      return;
    }

    const keyword = args.join(' ');
    const liveIds = new Set(ctx.sessionManager.listInfo('local').map((i) => i.id));

    let hits: SearchHit[] = [];
    try {
      const listings = await discoverSessions({ liveIds });
      const filtered = listings.filter((l) => l.workdir === ws.workdir);
      hits = await searchSessions(filtered, { query: keyword, limit: 10 });
    } catch (err) {
      await ctx.reply(`❌ 搜索失败: ${(err as Error).message}`);
      return;
    }

    if (hits.length === 0) {
      await ctx.reply(`🔍 "${keyword}" — 未找到匹配`);
      return;
    }
    const lines = [`🔍 "${keyword}" — ${hits.length} 条匹配`, ''];
    for (const h of hits) {
      const alias = h.sdkSessionId.replace(/-/g, '').slice(0, 8);
      lines.push(`• ${alias}: ${h.snippet}`);
    }
    await ctx.reply(lines.join('\n'));
  },
};
