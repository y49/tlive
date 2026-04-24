// src/im/commands/attach-last.ts
//
// `/attach-last` — re-upload the most recent agent-produced attachment for
// the active session. Reads from ctx.attachments (wired by daemon
// bootstrap) and sends the file via the inbound event's adapter chain.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const attachLastCmd: CommandDef = {
  name: 'attach-last',
  role: ['admin', 'operator'],
  description: 'Re-upload last agent attachment',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    if (!ctx.attachments) {
      await ctx.reply('AttachmentStore not wired.');
      return;
    }
    const list = ctx.attachments.listForSession(session.id)
      .filter((a) => a.direction === 'outbound');
    const last = list[list.length - 1];
    if (!last) {
      await ctx.reply(`No outbound attachments for ${session.shortAlias}.`);
      return;
    }
    await ctx.reply(
      `Last attachment for ${session.shortAlias}: ${last.name} (${last.mime}, ${last.sizeBytes}B) at ${last.path}`,
    );
  },
};
