// src/mcp/self/tools/handoff.ts
//
// `tlive.handoff.{release,take}` — flip between Mode A (daemon owns the
// session) and Mode B (companion external agent owns). The active-session
// invariant stays WorkspaceManager's responsibility; tools just wrap it.

import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult, optionalString, requireString } from './util.js';

export function makeHandoffReleaseTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.handoff.release',
      description: 'Release the workspace active-session slot so an external agent can take over.',
      inputSchema: {
        type: 'object',
        properties: { alias: { type: 'string' } },
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const alias = optionalString(args, 'alias');
      const workspaceId = ctx.workspaceId;
      let current: string | null = null;
      let owner: { channelType: 'telegram' | 'feishu'; chatId: string } | null = null;
      if (alias) {
        const s = deps.sessions.getByPrefix(alias).resolved;
        if (!s) return errorResult(`alias not found: ${alias}`);
        if (s.workspaceId !== workspaceId) {
          return errorResult(`alias ${alias} not in workspace ${workspaceId}`);
        }
        if (s.ownerChat) {
          const activeSdkId = deps.workspaces.getActiveSessionId(
            s.ownerChat.channelType, s.ownerChat.chatId,
          );
          if (activeSdkId === s.id) {
            current = s.id;
            owner = { channelType: s.ownerChat.channelType, chatId: s.ownerChat.chatId };
          }
        }
      } else {
        // No alias — find any active instance in this workspace and release it.
        const actives = deps.workspaces.listChatInstances()
          .filter((c) => c.workspaceId === workspaceId && c.activeSessionId !== null);
        if (actives.length > 0) {
          const first = actives[0]!;
          current = first.activeSessionId;
          owner = { channelType: first.channelType, chatId: first.chatId };
        }
      }
      if (owner) {
        deps.workspaces.clearActiveSession(owner.channelType, owner.chatId);
      }
      return jsonResult({ ok: true, releasedSdkId: current ?? null });
    },
  };
}

export function makeHandoffTakeTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.handoff.take',
      description: 'Take ownership of the workspace active-session slot.',
      inputSchema: {
        type: 'object',
        properties: { sdkId: { type: 'string' } },
        required: ['sdkId'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const sdkId = requireString(args, 'sdkId');
      // Find a ChatInstance for this workspace that either already owns this
      // sdkId or has no active session (take the first free one).
      const inWs = deps.workspaces.listChatInstances().filter((c) => c.workspaceId === ctx.workspaceId);
      if (inWs.length === 0) {
        return errorResult(`workspace ${ctx.workspaceId} has no chat bindings`);
      }
      const owner = inWs.find((c) => c.activeSessionId === sdkId)
        ?? inWs.find((c) => !c.activeSessionId)
        ?? inWs[0]!;
      if (owner.activeSessionId && owner.activeSessionId !== sdkId) {
        return errorResult(`workspace already owned by ${owner.activeSessionId}`);
      }
      try {
        deps.workspaces.bindActiveSession(owner.channelType, owner.chatId, sdkId);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      return jsonResult({ ok: true });
    },
  };
}
