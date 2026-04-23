// src/mcp/self/tools/workspace.ts
//
// `tlive.workspace.info()` — returns the workspace the calling agent is
// bound to (derived from the initialize-handshake cwd -> workspace lookup).

import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult } from './util.js';

export function makeWorkspaceInfoTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.workspace.info',
      description: 'Return info about the workspace the calling agent is bound to.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async handler(_args, ctx) {
      const ws = deps.workspaces.get(ctx.workspaceId);
      if (!ws) return errorResult(`workspace ${ctx.workspaceId} not found`);
      return jsonResult({
        id: ws.id,
        name: ws.name,
        workdir: ws.workdir,
        gitRemote: ws.gitRemote,
        provider: ws.defaults.provider,
        activeSessionId: ws.activeSessionId,
        defaultRole: ws.defaultRole,
      });
    },
  };
}
