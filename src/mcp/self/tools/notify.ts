// src/mcp/self/tools/notify.ts
//
// `tlive.notify.im(text, urgency?)` + `tlive.notify.leave(summary, when?)`.
// Tools just forward the message to the injected IMNotifier. T6 wires the
// actual platform adapter; tests use a spy.

import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, requireString, optionalString } from './util.js';

export function makeNotifyImTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.notify.im',
      description: 'Push a status message to the operator via IM.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const text = requireString(args, 'text');
      const urgency = optionalString(args, 'urgency') as 'low' | 'normal' | 'high' | undefined;
      await deps.notifier.notify(ctx.sessionId, text, { urgency });
      return jsonResult({ ok: true });
    },
  };
}

export function makeNotifyLeaveTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.notify.leave',
      description: 'Schedule a summary notification to the operator.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          when: { type: 'string', enum: ['session_end', 'now', 'next_idle'] },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const summary = requireString(args, 'summary');
      const when = (optionalString(args, 'when') ?? 'session_end') as 'session_end' | 'now' | 'next_idle';
      await deps.notifier.notify(ctx.sessionId, summary, { summary, when });
      return jsonResult({ ok: true, when });
    },
  };
}
