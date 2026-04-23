// src/mcp/self/tools/schedule.ts
//
// `tlive.schedule.{create, list, remove}` — wire into CronEngine.

import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult, requireString, optionalString } from './util.js';
import { getCronEngine } from '../cron.js';

export function makeScheduleCreateTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.schedule.create',
      description:
        'Schedule a prompt to run (cron | at | daily | weekly). '
        + 'Tasks fire within 60s of the target time; second-precision scheduling is not supported.',
      inputSchema: {
        type: 'object',
        properties: {
          cron: { type: 'string' },
          at: { type: 'string' },
          daily: { type: 'string' },
          weekly: { type: 'object' },
          prompt: { type: 'string' },
          provider: { type: 'string', enum: ['claude', 'codex'] },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const prompt = requireString(args, 'prompt');
      const provider = (optionalString(args, 'provider') ?? 'claude') as 'claude' | 'codex';
      const cron = optionalString(args, 'cron');
      const at = optionalString(args, 'at');
      const daily = optionalString(args, 'daily');
      const weekly = args.weekly as { day?: string; at?: string } | undefined;
      if (!cron && !at && !daily && !weekly) {
        return errorResult('must specify one of cron / at / daily / weekly');
      }
      const engine = await getCronEngine(deps);
      const task = await engine.add({
        cron: cron ?? null,
        at: at ?? null,
        daily: daily ?? null,
        weekly: (weekly && typeof weekly.day === 'string' && typeof weekly.at === 'string')
          ? { day: weekly.day, at: weekly.at } : null,
        workspaceId: ctx.workspaceId,
        prompt,
        provider,
      });
      return jsonResult({ id: task.id });
    },
  };
}

export function makeScheduleListTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.schedule.list',
      description: 'List scheduled tasks.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async handler() {
      const engine = await getCronEngine(deps);
      return jsonResult({ tasks: engine.list() });
    },
  };
}

export function makeScheduleRemoveTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.schedule.remove',
      description: 'Remove a scheduled task.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async handler(args) {
      const id = requireString(args, 'id');
      const engine = await getCronEngine(deps);
      const ok = await engine.remove(id);
      return jsonResult({ ok });
    },
  };
}
