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
      const current = deps.workspaces.getActiveSessionId(workspaceId);
      if (alias) {
        const s = deps.sessions.getByPrefix(alias).resolved;
        if (!s) return errorResult(`alias not found: ${alias}`);
        if (current && current !== s.id) {
          return errorResult(`active session ${current} does not match alias ${alias}`);
        }
      }
      deps.workspaces.clearActiveSession(workspaceId);
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
      const current = deps.workspaces.getActiveSessionId(ctx.workspaceId);
      if (current && current !== sdkId) {
        return errorResult(`workspace already owned by ${current}`);
      }
      try {
        deps.workspaces.bindActiveSession(ctx.workspaceId, sdkId);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      return jsonResult({ ok: true });
    },
  };
}
