// src/im/commands/find.ts
//
// /find <kw>           搜当前 chat 历史 (ownerChat 过滤)
// /find <kw> --workspace   搜跨 chat 同 ws (workdir 过滤)
// /find <kw> --all     全部 chat 历史

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';
import { discoverSessions, type SessionListing } from '../../session/discovery.js';
import { searchSessions, type SearchHit } from '../../session/search.js';

export const findCmd: CommandDef = {
  name: 'find',
  aliases: ['search'],
  description: '搜会话历史:默认当前 chat / --workspace / --all',
  async run(ctx, args) {
    const { flags, positional } = parseFlags(args);
    if (positional.length === 0) {
      await ctx.reply('用法: /find <关键词> [--workspace | --all]');
      return;
    }
    const wsScope = flags.workspace === true;
    const allScope = flags.all === true;
    const wm = ctx.workspaceManager;
    const channelType = ctx.inbound.channelType;
    const chatId = ctx.inbound.chatId;
    const keyword = positional.join(' ');

    let listings: SessionListing[];
    try {
      listings = await discoverSessions({ liveIds: new Set(ctx.sessionManager.listInfo('local').map((i) => i.id)) });
    } catch (err) {
      await ctx.reply(`❌ 搜索失败: ${(err as Error).message}`);
      return;
    }

    let scoped: SessionListing[];
    if (allScope) {
      scoped = listings;
    } else if (wsScope) {
      const ws = wm.workspaceForChat(channelType, chatId);
      if (!ws) { await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个'); return; }
      scoped = listings.filter((l) => l.workdir === ws.workdir);
    } else {
      // 默认:当前 chat — 用 ownerChat 过滤(discoverSessions 已携带 ownerChat)
      scoped = listings.filter((l) =>
        l.ownerChat?.channelType === channelType && l.ownerChat?.chatId === chatId,
      );
    }

    let hits: SearchHit[] = [];
    try { hits = await searchSessions(scoped, { query: keyword, limit: 10 }); }
    catch (err) { await ctx.reply(`❌ 搜索失败: ${(err as Error).message}`); return; }

    if (hits.length === 0) { await ctx.reply(`🔍 "${keyword}" — 未找到匹配`); return; }
    const scopeLabel = allScope ? '全部 chat' : wsScope ? '当前 ws' : '当前 chat';
    const lines = [`🔍 ${scopeLabel} "${keyword}" — ${hits.length} 条匹配`, ''];
    for (const h of hits) {
      const alias = h.sdkSessionId.replace(/-/g, '').slice(0, 8);
      lines.push(`• ${alias}: ${h.snippet}`);
    }
    await ctx.reply(lines.join('\n'));
  },
};
