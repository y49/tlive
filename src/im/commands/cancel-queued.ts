// src/im/commands/cancel-queued.ts
//
// `/cancel-queued [<n>]` — cancel the Nth queued input (0-based). No arg
// cancels the most recent queued input.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const cancelQueuedCmd: CommandDef = {
  name: 'cancel-queued',
  role: ['admin', 'operator'],
  description: 'Cancel a queued input',
  async run(ctx, args) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    const queue = session.queue;
    const size = queue.size();
    if (size === 0) { await ctx.reply('Queue is empty.'); return; }
    const idx = args[0] !== undefined ? Number(args[0]) : size - 1;
    if (!Number.isFinite(idx)) { await ctx.reply('Usage: /cancel-queued [<index>]'); return; }
    const removed = queue.cancelByIndex(idx);
    if (!removed) { await ctx.reply(`No queued input at index ${idx}.`); return; }
    await ctx.reply(`Cancelled queued input #${idx}: "${removed.text.slice(0, 40)}…"`);
  },
};
