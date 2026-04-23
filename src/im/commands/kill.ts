// src/im/commands/kill.ts
//
// `/kill` — force-stop the active session and release its jsonl so it can
// be resumed from scratch.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession, workspaceForChat } from './_shared.js';

export const killCmd: CommandDef = {
  name: 'kill',
  role: ['admin', 'operator'],
  description: 'Force kill session + release jsonl',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    const ws = workspaceForChat(ctx);
    await ctx.sessionManager.stop(session.id);
    if (ws) ctx.workspaceManager.clearActiveSession(ws.id);
    await ctx.reply(`Killed session ${session.shortAlias}.`);
  },
};
