// src/mcp/self/tools/ask.ts
//
// `tlive.ask.remote(prompt, options?, multiSelect?, timeoutMs?)` — surface a
// multi-choice ask to IM via AskUserQuestionBroker. Returns the chosen
// option(s). On timeout, returns an empty array.

import { randomBytes } from 'node:crypto';
import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult, requireString, optionalStringArray, optionalBoolean, optionalNumber } from './util.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function makeAskRemoteTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.ask.remote',
      description: 'Ask the operator a question with multiple choices. Blocks until answered or timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          multiSelect: { type: 'boolean' },
          timeoutMs: { type: 'number' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const prompt = requireString(args, 'prompt');
      const options = optionalStringArray(args, 'options') ?? ['yes', 'no'];
      const multiSelect = optionalBoolean(args, 'multiSelect') ?? false;
      const timeoutMs = optionalNumber(args, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS;

      const session = deps.sessions.get(ctx.sessionId);
      if (!session) return errorResult(`session ${ctx.sessionId} not found`);

      const id = `${ctx.sessionId}:ask-${randomBytes(4).toString('hex')}`;
      const chosen: string[] = await new Promise((resolve) => {
        let settled = false;
        const req = {
          id,
          prompt,
          options: options.map((label) => ({ label })),
          multiSelect,
          resolve: (value: string[]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          // Best-effort pull the request so the broker map doesn't leak.
          try { deps.askBroker.resolveById(id, []); } catch { /* isolate */ }
          resolve([]);
        }, Math.max(1, timeoutMs));
        if (session.kind === 'remote') session.addPendingAsk(req);
        deps.askBroker.issue(ctx.sessionId, req);
      });
      if (session.kind === 'remote') session.resolvePendingAsk(id, chosen);
      return jsonResult({ chosen });
    },
  };
}
