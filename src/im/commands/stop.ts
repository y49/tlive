// src/im/commands/stop.ts
//
// `/stop` — interrupt the current turn (does NOT stop the session).

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const stopCmd: CommandDef = {
  name: 'stop',
  role: ['admin', 'operator'],
  description: 'Interrupt the current turn',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    await session.interrupt();
    await ctx.reply(`Interrupted ${session.shortAlias}.`);
  },
};
