// src/im/commands/rewind.ts
//
// `/rewind <msg-id>` — apply a file-level rewind to the state at a prior
// message. Uses runtime.rewindFiles without dryRun.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const rewindCmd: CommandDef = {
  name: 'rewind',
  role: ['admin', 'operator'],
  description: 'Rewind files to a prior message state',
  async run(ctx, args) {
    const msgId = args[0];
    if (!msgId) { await ctx.reply('Usage: /rewind <msg-id>'); return; }
    const session = await activeLocalSession(ctx);
    if (!session) return;
    const res = await session.rewindFiles(msgId);
    if (!res.canRewind) { await ctx.reply(`Rewind failed: ${res.error ?? 'unknown'}.`); return; }
    await ctx.reply(`Rewound: ${res.filesChanged} files, +${res.insertions}/-${res.deletions}.`);
  },
};
