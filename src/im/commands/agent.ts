// src/im/commands/agent.ts
//
// `/agent [list|create <name> "<desc>" [--model=X] [--tools=...]|remove <n>]`
// — subagent authoring. `list` queries the live runtime (so workspace-
// scoped agents surface). `create` / `remove` write to
// `~/.claude/agents/<name>.md`.

import type { CommandDef } from '../command-parser.js';
import { activeLocalSession } from './_shared.js';
import { parseFlags, parseQuotedTail } from '../command-parser.js';
import { writeClaudeAgent, removeClaudeAgent } from '../../skills/installer.js';

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
      const tools = typeof flags.tools === 'string'
        ? flags.tools.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;
      try {
        const path = await writeClaudeAgent({ name, description: desc, model, tools });
        await ctx.reply(`Agent ${name} written to ${path}.`);
      } catch (err) {
        await ctx.reply(`Agent create failed: ${(err as Error).message}`);
      }
      return;
    }
    if (sub === 'remove') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /agent remove <name>'); return; }
      const ok = await removeClaudeAgent(name);
      await ctx.reply(ok ? `Agent ${name} removed.` : `Agent ${name} not found.`);
      return;
    }
    await ctx.reply('Usage: /agent [list|create|remove]');
  },
};
