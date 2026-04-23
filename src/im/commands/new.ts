// src/im/commands/new.ts
//
// `/new [prompt]` / `/new --ephemeral <prompt>` / `/new --model=<m> --effort=<e> <prompt>`
// — creates a fresh LocalSession bound to the workspace for this chat.

import type { CommandDef } from '../command-parser.js';
import { parseFlags } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const newCmd: CommandDef = {
  name: 'new',
  role: ['admin', 'operator'],
  description: 'Create a new session',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound to this chat.'); return; }

    const { flags, positional } = parseFlags(args);
    const prompt = positional.join(' ').trim() || undefined;
    const model = typeof flags.model === 'string' ? flags.model : ws.defaults.model;
    const effort = typeof flags.effort === 'string' ? flags.effort as 'low' | 'medium' | 'high' | 'max' : ws.defaults.effort;
    const ephemeral = flags.ephemeral === true;

    const session = await ctx.sessionManager.createLocal({
      workspaceId: ws.id,
      workspaceName: ws.name,
      provider: ws.defaults.provider,
      workdir: ws.workdir,
      initialPrompt: prompt,
      model,
      effort,
      source: 'im',
    });
    try { ctx.workspaceManager.bindActiveSession(ws.id, session.id); }
    catch { /* conflict — caller initiated a race; not fatal */ }

    const tag = ephemeral ? ' (ephemeral)' : '';
    await ctx.reply(`Session ${session.shortAlias} started${tag} on ${ws.name}.`);
  },
};
