// src/im/commands/stop.ts
//
// /stop — interrupt the current in-flight turn (Ctrl+C / ESC equivalent).
// Per spec §3 — does NOT stop the session (process stays alive,
// jsonl preserved, next user message resumes cleanly).

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const stopCmd: CommandDef = {
  name: 'stop',
  role: ['admin', 'operator'],
  description: '中断当前 turn (Ctrl+C 等价)',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;

    const status = session.getStatus();
    if (status !== 'active') {
      await ctx.reply('当前没有进行中的对话');
      return;
    }

    try {
      await session.interrupt();
      await ctx.reply('⏹ 已中断当前生成\n   会话仍活跃,可以继续发指令');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ 中断失败: ${msg}`);
    }
  },
};
