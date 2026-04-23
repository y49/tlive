// src/im/commands/time-travel.ts
//
// `/time-travel <alias> <msg-id>` — rewind the conversation to a prior
// message state (no file changes). Uses runtime.rewindFiles with dryRun
// to preview safely.

import type { CommandDef } from '../command-parser.js';
import { resolveSessionArg } from './_shared.js';

export const timeTravelCmd: CommandDef = {
  name: 'time-travel',
  role: ['admin', 'operator'],
  description: 'Rewind conversation to a prior message',
  async run(ctx, args) {
    const [alias, msgId] = args;
    if (!alias || !msgId) { await ctx.reply('Usage: /time-travel <alias> <msg-id>'); return; }
    const target = await resolveSessionArg(ctx, alias);
    if (!target) return;
    if (target.kind !== 'local') { await ctx.reply('Cannot time-travel a remote session.'); return; }
    const res = await target.rewindFiles(msgId, { dryRun: true });
    if (!res.canRewind) { await ctx.reply(`Time-travel unavailable: ${res.error ?? 'unknown'}.`); return; }
    await ctx.reply(`Rewind preview: ${res.filesChanged} files, +${res.insertions}/-${res.deletions}. Run /rewind to apply.`);
  },
};
