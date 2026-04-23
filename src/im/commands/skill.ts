// src/im/commands/skill.ts
//
// `/skill [list|install <path|url>|remove <n>]` — skill authoring.

import type { CommandDef } from '../command-parser.js';

export const skillCmd: CommandDef = {
  name: 'skill',
  role: ['admin'],
  description: 'Authoring: skills',
  async run(ctx, args) {
    const sub = args[0] ?? 'list';
    if (sub === 'list') {
      await ctx.reply('Skill list not yet exposed (TODO T9 — scan ~/.claude/skills).');
      return;
    }
    if (sub === 'install') {
      const src = args[1];
      if (!src) { await ctx.reply('Usage: /skill install <path|url>'); return; }
      await ctx.reply(`Install ${src}. (TODO T9: wire skills installer.)`);
      return;
    }
    if (sub === 'remove') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /skill remove <name>'); return; }
      await ctx.reply(`Remove ${name}. (TODO T9)`);
      return;
    }
    await ctx.reply('Usage: /skill [list|install|remove]');
  },
};
