// src/im/commands/models.ts
//
// `/models` — list models available to the current session's runtime.
// Pulled dynamically from the runtime's supportedModels() RPC.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';

export const modelsCmd: CommandDef = {
  name: 'models',
  role: ['admin', 'operator', 'observer'],
  description: 'List available models',
  async run(ctx) {
    const session = await activeLocalSession(ctx);
    if (!session) return;
    const maybe = (session as unknown as { supportedModels?: () => Promise<Array<{ id: string; displayName?: string }>> }).supportedModels;
    if (typeof maybe !== 'function') { await ctx.reply('Runtime does not expose supportedModels().'); return; }
    const list = await maybe.call(session);
    if (list.length === 0) { await ctx.reply('(runtime reports no models)'); return; }
    const lines = list.map((m) => `• ${m.id}${m.displayName ? ` — ${m.displayName}` : ''}`);
    await ctx.reply(['Models:', ...lines].join('\n'));
  },
};
