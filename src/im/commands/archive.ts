// src/im/commands/archive.ts
//
// `/archive <alias>` — move a session into archived state. The SDK's
// session persistence doesn't expose a hard archive operation at this
// layer; we stop the session (releasing the jsonl) and mark it stopped
// in manager. T9 can extend with persistent archived flag.

import type { CommandDef } from '../command-parser.js';
import { resolveSessionArg, workspaceForChat } from './_shared.js';

export const archiveCmd: CommandDef = {
  name: 'archive',
  role: ['admin', 'operator'],
  description: 'Archive a session',
  async run(ctx, args) {
    const target = await resolveSessionArg(ctx, args[0] ?? '');
    if (!target) return;
    await ctx.sessionManager.stop(target.id);
    const ws = workspaceForChat(ctx);
    if (ws && ws.activeSessionId === target.id) ctx.workspaceManager.clearActiveSession(ws.id);
    await ctx.reply(`Archived ${target.shortAlias}. (TODO T9: persistent archive flag.)`);
  },
};
