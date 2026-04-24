// src/im/commands/takeback.ts
//
// `/takeback` — owner reclaims a session that was previously
// `/handoff-to-me`'d to a different user (spec §1.2 mode transitions).
// Resume the active session if stopped and clear any handed_off flag.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const takebackCmd: CommandDef = {
  name: 'takeback',
  role: ['admin', 'operator'],
  description: 'Take back a handed-off session',
  async run(ctx) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    const activeId = ws.activeSessionId;
    if (!activeId) { await ctx.reply('No active session to take back.'); return; }
    const live = ctx.sessionManager.get(activeId);
    if (live) { await ctx.reply(`Already live: ${live.shortAlias}.`); return; }
    const resumed = await ctx.sessionManager.resumeLocal(activeId).catch(() => null);
    if (!resumed) { await ctx.reply('Session invalidated; cannot take back.'); return; }
    // A `handed_off` flag is not persisted yet (spec §1.2 deferred); the
    // resume itself is sufficient to reclaim ownership in v1.0.
    await ctx.reply(`Took back ${resumed.shortAlias}.`);
  },
};
