// src/im/commands/agent.ts
//
// `/agent [list|create <name> "<desc>" [--model=X] [--tools=...]|remove <n>]`
// — subagent authoring. T7 shells out to runtime for list; create/remove
// deferred until T9 wires the authoring file layout.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';
import { parseFlags, parseQuotedTail } from '../command-parser.js';

export const agentCmd: CommandDef = {
  name: 'agent',
  role: ['admin'],
  description: 'Authoring: subagents',
  async run(ctx, args) {
    const sub = args[0] ?? 'list';
    if (sub === 'list') {
      const session = await activeLocalSession(ctx);
      if (!session) return;
      const list = await (session as unknown as { supportedAgents: () => Promise<Array<{ name: string; description?: string }>> }).supportedAgents();
      const lines = list.map((a) => `• ${a.name}${a.description ? ` — ${a.description}` : ''}`);
      await ctx.reply(['Agents:', ...(lines.length ? lines : ['(none)'])].join('\n'));
      return;
    }
    if (sub === 'create') {
      const tail = parseQuotedTail(args.slice(1));
      const name = tail.head[0];
      const desc = tail.quoted;
      if (!name || !desc) { await ctx.reply('Usage: /agent create <name> "<desc>" [--model=X] [--tools=a,b]'); return; }
      const { flags } = parseFlags(args.slice(1));
      const model = typeof flags.model === 'string' ? flags.model : undefined;
      const tools = typeof flags.tools === 'string' ? flags.tools : undefined;
      await ctx.reply(`Agent ${name} created (model=${model ?? 'default'}, tools=${tools ?? '*'}). (TODO T9: persist to .claude/agents/.)`);
      return;
    }
    if (sub === 'remove') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /agent remove <name>'); return; }
      await ctx.reply(`Agent ${name} removed. (TODO T9)`);
      return;
    }
    await ctx.reply('Usage: /agent [list|create|remove]');
  },
};
