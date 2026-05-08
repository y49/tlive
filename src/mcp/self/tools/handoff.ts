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
      // Per chat-level isolation (spec §3) the active-session slot lives on
      // each ChatBinding rather than the Workspace. With ownerChat plumbing
      // (Iso #5) we look up the session's owner directly instead of scanning
      // listActiveBindings.
      let current: string | null = null;
      let owner: { channelType: 'telegram' | 'feishu'; chatId: string } | null = null;
      if (alias) {
        const s = deps.sessions.getByPrefix(alias).resolved;
        if (!s) return errorResult(`alias not found: ${alias}`);
        if (s.workspaceId !== workspaceId) {
          return errorResult(`alias ${alias} not in workspace ${workspaceId}`);
        }
        if (s.ownerChat) {
          const activeSdkId = deps.workspaces.getActiveSessionIdForChat(
            s.ownerChat.channelType, s.ownerChat.chatId,
          );
          if (activeSdkId === s.id) {
            current = s.id;
            owner = { channelType: s.ownerChat.channelType, chatId: s.ownerChat.chatId };
          }
        }
      } else {
        // No alias — find any active binding in this workspace and release it.
        const actives = deps.workspaces.listActiveBindings()
          .filter((b) => b.workspaceId === workspaceId);
        if (actives.length > 0) {
          const first = actives[0]!;
          current = first.activeSessionId;
          owner = { channelType: first.channelType, chatId: first.chatId };
        }
      }
      if (owner) {
        deps.workspaces.clearActiveSessionForChat(owner.channelType, owner.chatId);
      }
      // `releasedSdkId` is null when the slot was already free so callers
      // can branch cleanly on presence rather than inspecting the old
      // ambiguous `sdkId` field.
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
      // TODO(Iso #5): once Session carries ownerChat, this tool should look
      // it up off the live session rather than scanning bindings. For now
      // we find the binding by activeSessionId or, when free, take the
      // first binding in this workspace.
      const inWs = deps.workspaces.listBindings(ctx.workspaceId);
      if (inWs.length === 0) {
        return errorResult(`workspace ${ctx.workspaceId} has no chat bindings`);
      }
      const owner = inWs.find((b) => b.activeSessionId === sdkId)
        ?? inWs.find((b) => !b.activeSessionId)
        ?? inWs[0]!;
      if (owner.activeSessionId && owner.activeSessionId !== sdkId) {
        return errorResult(`workspace already owned by ${owner.activeSessionId}`);
      }
      try {
        deps.workspaces.bindActiveSessionForChat(owner.channelType, owner.chatId, sdkId);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      return jsonResult({ ok: true });
    },
  };
}
