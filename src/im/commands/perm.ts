// src/im/commands/perm.ts
//
// `/perm allow <pattern>` / `/perm deny <pattern>` / `/perm list` — manage
// the workspace's PermissionBroker auto-resolve policy rules. Delegates to
// the per-workspace PolicyStore when one is resolvable via ctx.

import type { CommandDef } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const permCmd: CommandDef = {
  name: 'perm',
  role: ['admin', 'operator'],
  description: 'Manage permission rules',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    const sub = args[0];
    const store = ctx.policyStoreFor?.(ws.id);
    if (!store) { await ctx.reply('PolicyStore not wired (TODO T9).'); return; }

    if (sub === 'list') {
      const rules = store.list();
      if (rules.length === 0) { await ctx.reply('No policy rules.'); return; }
      const lines = rules.map((r) => `• [${r.id}] ${r.decision} ${r.pattern.toolName ?? '*'}`);
      await ctx.reply(['Policy rules:', ...lines].join('\n'));
      return;
    }
    if (sub === 'allow' || sub === 'deny') {
      const pattern = args[1];
      if (!pattern) { await ctx.reply(`Usage: /perm ${sub} <toolName[:jsonInput]>`); return; }
      const rule = await store.add(
        { toolName: pattern },
        sub,
        'workspace',
        ctx.userId,
      );
      await ctx.reply(`Added ${sub} rule ${rule.id} for ${pattern}.`);
      return;
    }
    await ctx.reply('Usage: /perm allow <pattern> | /perm deny <pattern> | /perm list');
  },
};
