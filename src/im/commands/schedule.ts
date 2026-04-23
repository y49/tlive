// src/im/commands/schedule.ts
//
// `/schedule [list|create <cron|at|daily|weekly> <prompt>|remove <id>]` —
// scheduled prompts via the CronEngine (T5). T9 wires the CronEngine
// instance onto ctx.

import type { CommandDef } from '../command-parser.js';

export const scheduleCmd: CommandDef = {
  name: 'schedule',
  role: ['admin', 'operator'],
  description: 'Manage scheduled prompts',
  async run(ctx, args) {
    const sub = args[0] ?? 'list';
    if (sub === 'list') {
      await ctx.reply('Schedules: (TODO T9 — CronEngine wiring pending).');
      return;
    }
    if (sub === 'create') {
      const kind = args[1];
      if (!kind) { await ctx.reply('Usage: /schedule create <cron|at|daily|weekly> <prompt>'); return; }
      await ctx.reply(`Schedule (${kind}) queued. (TODO T9)`);
      return;
    }
    if (sub === 'remove') {
      const id = args[1];
      if (!id) { await ctx.reply('Usage: /schedule remove <id>'); return; }
      await ctx.reply(`Schedule ${id} removed. (TODO T9)`);
      return;
    }
    await ctx.reply('Usage: /schedule [list|create|remove]');
  },
};
