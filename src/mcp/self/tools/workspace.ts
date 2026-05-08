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
      // Per chat-instance model (spec 2026-05-08 §3), active sessions live on
      // ChatInstances, not the Workspace. Return per-chat active sessions.
      const activeSessions = deps.workspaces.listChatInstances()
        .filter((c) => c.workspaceId === ctx.workspaceId && c.activeSessionId !== null)
        .map((c) => ({
          channelType: c.channelType,
          chatId: c.chatId,
          activeSessionId: c.activeSessionId!,
        }));
      return jsonResult({
        id: ws.id,
        name: ws.name,
        workdir: ws.workdir,
        gitRemote: ws.gitRemote,
        provider: ws.defaults.provider,
        activeSessions,
      });
    },
  };
}
