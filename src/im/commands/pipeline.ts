// src/im/commands/pipeline.ts
//
// `/pipeline [list|create <name> <stepsJson>|run <name> <input>|remove <n>]`
// — pipeline orchestration via the MCP self subsystem. Stub-level wiring
// until T9 plumbs a PipelineStore reference through ctx.

import type { CommandDef } from '../command-parser.js';

export const pipelineCmd: CommandDef = {
  name: 'pipeline',
  role: ['admin', 'operator'],
  description: 'Manage MCP pipelines',
  async run(ctx, args) {
    const sub = args[0] ?? 'list';
    if (sub === 'list') {
      await ctx.reply('Pipelines: (TODO T9 — PipelineStore wiring pending).');
      return;
    }
    if (sub === 'create') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /pipeline create <name> <stepsJson>'); return; }
      await ctx.reply(`Pipeline ${name} registered. (TODO T9)`);
      return;
    }
    if (sub === 'run') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /pipeline run <name> <input>'); return; }
      await ctx.reply(`Running pipeline ${name}... (TODO T9 — orchestrator.runPipeline wiring).`);
      return;
    }
    if (sub === 'remove') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /pipeline remove <name>'); return; }
      await ctx.reply(`Pipeline ${name} removed. (TODO T9)`);
      return;
    }
    await ctx.reply('Usage: /pipeline [list|create|run|remove]');
  },
};
