// src/mcp/self/tools/sync.ts
//
// `tlive.sync.state(phase, detail?)` — propagate external agent lifecycle
// into the matching RemoteSession so IM renderers reflect remote status.

import type { McpTool, McpToolDeps } from '../deps.js';
import type { AgentStatus } from '../../../session/status.js';
import { jsonResult, errorResult, requireString, optionalObject } from './util.js';

const VALID_PHASES: AgentStatus['phase'][] = [
  'initializing', 'idle', 'thinking',
  'awaiting_permission', 'awaiting_question', 'awaiting_elicitation',
  'interrupted', 'handed_off', 'errored', 'stopped',
];

export function makeSyncStateTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.sync.state',
      description: 'Update the RemoteSession status from the calling agent.',
      inputSchema: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: VALID_PHASES as string[] },
          detail: { type: 'object' },
        },
        required: ['phase'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const phase = requireString(args, 'phase') as AgentStatus['phase'];
      if (!VALID_PHASES.includes(phase)) return errorResult(`invalid phase: ${phase}`);
      const detail = optionalObject(args, 'detail');
      const s = deps.sessions.get(ctx.sessionId);
      if (!s || s.kind !== 'remote') {
        return errorResult(`session ${ctx.sessionId} is not a RemoteSession`);
      }
      const currentTool = detail && typeof detail.currentTool === 'string' ? detail.currentTool : undefined;
      const reason = detail && typeof detail.reason === 'string' ? detail.reason : undefined;
      s.setStatus(phase, { currentTool, reason });
      return jsonResult({ ok: true });
    },
  };
}
