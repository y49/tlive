// src/im/commands/agents.ts
//
// `/agents` — list registered subagents for the current session's runtime.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const agentsCmd: CommandDef = {
  name: 'agents',
  role: ['admin', 'operator', 'observer'],
  description: 'List registered subagents',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    const maybe = (session as unknown as { supportedAgents?: () => Promise<Array<{ name: string; description?: string }>> }).supportedAgents;
    if (typeof maybe !== 'function') { await ctx.reply('Runtime does not expose supportedAgents().'); return; }
    const list = await maybe.call(session);
    if (list.length === 0) { await ctx.reply('(no subagents registered)'); return; }
    const lines = list.map((a) => `• ${a.name}${a.description ? ` — ${a.description}` : ''}`);
    await ctx.reply(['Agents:', ...lines].join('\n'));
  },
};
