// src/im/commands/resume.ts
//
// `/resume <alias>` — resume a stopped session by short-id alias.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const resumeCmd: CommandDef = {
  name: 'resume',
  role: ['admin', 'operator'],
  description: 'Resume a stopped session',
  async run(ctx, args) {
    const alias = args[0];
    if (!alias) { await ctx.reply('Usage: /resume <short-alias>'); return; }
    // resume by prefix — try exact first, fallback to prefix scan across meta
    const live = ctx.sessionManager.getByPrefix(alias).resolved;
    if (live) { await ctx.reply(`Session ${live.shortAlias} is already live.`); return; }
    const resumed = await ctx.sessionManager.resumeLocal(alias).catch(() => null);
    if (!resumed) { await ctx.reply(`No session found for '${alias}'.`); return; }
    const ws = workspaceForChat(ctx);
    if (ws) {
      try { ctx.workspaceManager.bindActiveSession(ws.id, resumed.id); }
      catch { /* conflict non-fatal */ }
    }
    await ctx.reply(`Resumed ${resumed.shortAlias}.`);
  },
};
