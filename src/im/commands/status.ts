// src/im/commands/status.ts
//
// `/status` — one-line status of the active session (phase, cost, tokens).

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const statusCmd: CommandDef = {
  name: 'status',
  role: ['admin', 'operator', 'observer'],
  description: 'Show active session status',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    const snap = session.snapshot();
    const c = snap.cost;
    const title = snap.title ? ` — ${snap.title}` : '';
    const line =
      `${snap.shortAlias}${title} · ${snap.status.phase} · ` +
      `$${c.totalCost.toFixed(4)} · in=${c.inputTokens} out=${c.outputTokens}`;
    await ctx.reply(line);
  },
};
