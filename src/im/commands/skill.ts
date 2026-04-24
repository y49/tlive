// src/im/commands/skill.ts
//
// `/skill [list|install <path>|remove <name>]` — skill authoring backed by
// `src/skills/installer.ts`. Skills live under `~/.claude/skills/`; each
// subdirectory is one skill. URL installs are rejected (offline-first).

import type { CommandDef } from '../command-parser.js';
import {
  listClaudeSkills, installClaudeSkill, removeClaudeSkill,
} from '../../skills/installer.js';

export const skillCmd: CommandDef = {
  name: 'skill',
  role: ['admin'],
  description: 'Authoring: skills',
  async run(ctx, args) {
    const sub = args[0] ?? 'list';
    if (sub === 'list') {
      const skills = await listClaudeSkills().catch(() => []);
      if (skills.length === 0) { await ctx.reply('No skills installed.'); return; }
      const lines = skills.map((s) => `• ${s.name}`);
      await ctx.reply(['Skills:', ...lines].join('\n'));
      return;
    }
    if (sub === 'install') {
      const src = args[1];
      if (!src) { await ctx.reply('Usage: /skill install <path>'); return; }
      if (/^https?:\/\//i.test(src)) {
        await ctx.reply('URL skills are not supported; download first and pass the local path.');
        return;
      }
      try {
        const entry = await installClaudeSkill(src);
        await ctx.reply(`Installed ${entry.name} → ${entry.path}`);
      } catch (err) {
        await ctx.reply(`Install failed: ${(err as Error).message}`);
      }
      return;
    }
    if (sub === 'remove') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /skill remove <name>'); return; }
      const ok = await removeClaudeSkill(name);
      await ctx.reply(ok ? `Removed ${name}.` : `Skill ${name} not found.`);
      return;
    }
    await ctx.reply('Usage: /skill [list|install|remove]');
  },
};
