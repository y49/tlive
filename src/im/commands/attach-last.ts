// src/im/commands/attach-last.ts
//
// `/attach-last` — re-upload the most recent agent-produced attachment for
// the active session. TODO(T9): thread the AttachmentStore reference.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const attachLastCmd: CommandDef = {
  name: 'attach-last',
  role: ['admin', 'operator'],
  description: 'Re-upload last agent attachment',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    // TODO(T9): AttachmentStore.findLast(sessionId) → adapter.sendAttachment.
    await ctx.reply(`/attach-last for ${session.shortAlias}: AttachmentStore not wired (TODO T9).`);
  },
};
