// src/im/commands/stop-task.ts
//
// `/stop-task <agent-short-id>` — stop a single subagent/task leg without
// interrupting the whole turn.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const stopTaskCmd: CommandDef = {
  name: 'stop-task',
  role: ['admin', 'operator'],
  description: 'Stop a subagent/task leg',
  async run(ctx, args) {
    const taskId = args[0];
    if (!taskId) { await ctx.reply('Usage: /stop-task <agent-short-id>'); return; }
    const session = await activeLocalSession(ctx);
    if (!session) return;
    await session.stopTask(taskId);
    await ctx.reply(`Task ${taskId} stopped.`);
  },
};
