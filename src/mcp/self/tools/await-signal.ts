// src/mcp/self/tools/await-signal.ts
//
// `tlive.await_signal(kind, timeoutMs)` + `tlive.await_user_input(timeoutMs)`
// — long-poll helpers that block the caller on an `InMemorySignalBus`. IM
// command router emits signals when the user types /interrupt etc.

import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult, requireString, optionalNumber } from './util.js';

const DEFAULT_TIMEOUT = 5 * 60_000;

export function makeAwaitSignalTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.await_signal',
      description: 'Block the calling agent until a named signal is emitted or timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['interrupt', 'user_input', 'any'] },
          timeoutMs: { type: 'number' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const kind = requireString(args, 'kind') as 'interrupt' | 'user_input' | 'any';
      if (kind !== 'interrupt' && kind !== 'user_input' && kind !== 'any') {
        return errorResult(`invalid signal kind: ${kind}`);
      }
      const timeoutMs = optionalNumber(args, 'timeoutMs') ?? DEFAULT_TIMEOUT;
      const got = await deps.signals.await(ctx.sessionId, kind, timeoutMs);
      return jsonResult({ signal: got });
    },
  };
}

export function makeAwaitUserInputTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.await_user_input',
      description: 'Block the calling agent until the operator sends free-text input.',
      inputSchema: {
        type: 'object',
        properties: { timeoutMs: { type: 'number' } },
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const timeoutMs = optionalNumber(args, 'timeoutMs') ?? DEFAULT_TIMEOUT;
      const got = await deps.signals.await(ctx.sessionId, 'user_input', timeoutMs);
      return jsonResult({ input: got?.payload ?? null });
    },
  };
}
