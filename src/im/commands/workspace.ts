// src/im/commands/workspace.ts
//
// `/workspace [show|set-default|system-prompt "<text>"]` — admin-only
// workspace config edits.

import type { CommandDef } from '../command-parser.js';
import { parseQuoted, workspaceForChat } from './_shared.js';

export const workspaceCmd: CommandDef = {
  name: 'workspace',
  role: ['admin'],
  description: 'Manage workspace config',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    const sub = args[0] ?? 'show';

    if (sub === 'show') {
      const lines = [
        `Workspace: ${ws.name} (${ws.id.slice(0, 8)})`,
        `Workdir: ${ws.workdir}`,
        `Provider: ${ws.defaults.provider}`,
        `Model: ${ws.defaults.model ?? '(default)'}`,
        `Mode: ${ws.defaults.permissionMode}`,
        `Default role: ${ws.defaultRole}`,
        `Bindings: ${ws.bindings.length}`,
      ];
      await ctx.reply(lines.join('\n'));
      return;
    }
    if (sub === 'set-default') {
      const target = ws.id;
      // "default" in the spec means "primary workspace for this user" — until
      // T9 maintains a default map, just confirm the op.
      await ctx.reply(`Workspace ${target.slice(0, 8)} set as default. (TODO T9)`);
      return;
    }
    if (sub === 'system-prompt') {
      const { quoted } = parseQuoted(args.slice(1));
      if (quoted === null) { await ctx.reply('Usage: /workspace system-prompt "<text>"'); return; }
      ws.defaults.systemPromptAppend = quoted;
      await ctx.workspaceManager.save();
      await ctx.reply('System prompt append updated.');
      return;
    }
    await ctx.reply('Usage: /workspace [show|set-default|system-prompt "<text>"]');
  },
};
