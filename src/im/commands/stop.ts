// src/im/commands/stop.ts
//
// /stop — interrupt the current in-flight turn (Ctrl+C / ESC equivalent).
// Stub — full implementation in Task 8.

import type { CommandDef } from '../command-parser.js';

export const stopCmd: CommandDef = {
  name: 'stop',
  role: ['admin', 'operator'],
  description: '中断当前 turn (Ctrl+C 等价)',
  async run(ctx) { await ctx.reply('TODO: stop'); },
};
