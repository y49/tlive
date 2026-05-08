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
      // Per chat-level isolation (spec §3), there is no single workspace-wide
      // active session — each ChatBinding owns its own. Return the array so
      // callers can see per-chat ownership.
      const activeSessions = ws.bindings
        .filter((b) => b.activeSessionId)
        .map((b) => ({
          channelType: b.channelType,
          chatId: b.chatId,
          activeSessionId: b.activeSessionId!,
        }));
      return jsonResult({
        id: ws.id,
        name: ws.name,
        workdir: ws.workdir,
        gitRemote: ws.gitRemote,
        provider: ws.defaults.provider,
        activeSessions,
        defaultRole: ws.defaultRole,
      });
    },
  };
}
