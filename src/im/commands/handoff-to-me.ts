// src/im/commands/handoff-to-me.ts
//
// `/handoff-to-me` — stop the active session and mark it as handed-off to
// the caller. Until T9 stores the handoff pointer, we just stop the
// session and leave the workspace's activeSessionId pointing at it so
// `/takeback` works.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const handoffToMeCmd: CommandDef = {
  name: 'handoff-to-me',
  role: ['admin', 'operator'],
  description: 'Hand the session off to yourself',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    await ctx.sessionManager.stop(session.id);
    // NB: intentionally keep workspace.activeSessionId pointed at session.id
    // so `/takeback` can resume the same sdkSessionId.
    await ctx.reply(`Handed off ${session.shortAlias}. Resume locally with 'tlive resume ${session.shortAlias}' or /takeback.`);
  },
};
