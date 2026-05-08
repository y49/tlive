// src/im/commands/cost.ts
//
// /cost                     当前 chat 累积(ChatInstance.costRollup)
// /cost --workspace         同 workspace 跨 chat 总和(逐 chat 列出)
// /cost --all               所有 workspace 全部 chatInstance 总和
//
// Per-chat cost 来源:每个 LocalSession 在 turn_end 时调
// wm.addCost(channel, chat, deltaUsd, false)。详见 frontend.ts。

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';

export const costCmd: CommandDef = {
  name: 'cost',
  description: '当前 chat / 工作区 / 全局成本',
  async run(ctx, args) {
    const { flags } = parseFlags(args);
    const wsScope = flags.workspace === true;
    const allScope = flags.all === true || flags.global === true;
    const wm = ctx.workspaceManager;
    const channelType = ctx.inbound.channelType;
    const chatId = ctx.inbound.chatId;

    if (allScope) {
      const all = wm.listChatInstances();
      const total = all.reduce((sum, c) => sum + c.costRollup.totalUsd, 0);
      const sessions = all.reduce((sum, c) => sum + c.costRollup.sessionCount, 0);
      await ctx.reply(`💰 全部 chat: $${total.toFixed(4)} (${sessions} sessions, ${all.length} chats)`);
      return;
    }

    if (wsScope) {
      const ws = wm.workspaceForChat(channelType, chatId);
      if (!ws) {
        await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个');
        return;
      }
      const peers = wm.listChatInstances().filter((c) => c.workspaceId === ws.id);
      const total = peers.reduce((sum, c) => sum + c.costRollup.totalUsd, 0);
      const lines = [`📊 workspace ${ws.name} 总和`];
      for (const c of peers) {
        const tag = c.chatId.slice(0, 16);
        lines.push(`  chat ${tag}: $${c.costRollup.totalUsd.toFixed(4)} (${c.costRollup.sessionCount} sessions)`);
      }
      lines.push('────────', `合计: $${total.toFixed(4)}`);
      await ctx.reply(lines.join('\n'));
      return;
    }

    // 默认:当前 chat
    const inst = wm.findChatInstance(channelType, chatId);
    if (!inst) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个');
      return;
    }
    await ctx.reply(
      `💰 此 chat: $${inst.costRollup.totalUsd.toFixed(4)} (${inst.costRollup.sessionCount} sessions)`,
    );
  },
};
