// src/im/commands/resume.ts
//
// `/resume <alias>` — resume a stopped session by short-id alias.
//
// Ambiguity handling: we use `resolveSessionArg` with `includeStopped: true`.
// For an ambiguous prefix across live sessions the helper replies with the
// candidate list and returns null (we stop). For a clean live-prefix miss
// we fall through to `sessionManager.resumeLocal(alias)` which tries the
// meta-backed resume path. Unique live hits short-circuit with "already live".

import type { CommandDef } from '../command-parser.js';
import { resolveSessionArg, workspaceForChat } from './_shared.js';

export const resumeCmd: CommandDef = {
  name: 'resume',
  role: ['admin', 'operator'],
  description: 'Resume a stopped session',
  async run(ctx, args) {
    const alias = args[0];
    if (!alias) { await ctx.reply('Usage: /resume <short-alias>'); return; }

    // Live-prefix probe. On ambiguity the helper already replied; bail.
    const live = await resolveSessionArg(ctx, alias, { includeStopped: true });
    if (live) { await ctx.reply(`Session ${live.shortAlias} is already live.`); return; }
    // resolveSessionArg returned null — but check if it bailed due to
    // ambiguity (helper replied) or clean miss. The helper only replies on
    // ambiguity when includeStopped is set, so we detect the ambiguity case
    // by re-inspecting the prefix result.
    const probe = ctx.sessionManager.getByPrefix(alias);
    if (probe.ambiguous.length > 1) return; // helper already replied

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
