// src/im/commands/find.ts
//
// /find <keyword> — search workspace conversation history.
// Stub — full implementation in Task 25.

import type { CommandDef } from '../command-parser.js';

export const findCmd: CommandDef = {
  name: 'find',
  aliases: ['search'],
  role: ['admin', 'operator', 'observer'],
  description: '搜索当前工作区会话历史',
  async run(ctx) { await ctx.reply('TODO: find'); },
};
