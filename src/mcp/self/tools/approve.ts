// src/mcp/self/tools/approve.ts
//
// `tlive.approve(toolName, toolInput, toolUseId?)` — route a permission
// request through PermissionBroker so it surfaces on IM. Blocks until a
// human (or a matching PolicyStore rule) resolves it.

import { randomBytes } from 'node:crypto';
import type { PermissionCategory, PermissionDecision } from '../../../runtime/types.js';
import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult, requireString, optionalObject, optionalString } from './util.js';

function categorize(toolName: string): PermissionCategory {
  const lower = toolName.toLowerCase();
  if (lower === 'bash' || lower.startsWith('exec') || lower.startsWith('shell')) return 'exec';
  if (lower === 'edit' || lower === 'write' || lower === 'notebookedit' || lower.includes('file')) return 'file-edit';
  return 'generic';
}

export function makeApproveTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.approve',
      description: "Route a permission request to the user's IM. Blocks until resolved.",
      inputSchema: {
        type: 'object',
        properties: {
          toolName: { type: 'string' },
          toolInput: { type: 'object' },
          toolUseId: { type: 'string' },
        },
        required: ['toolName', 'toolInput'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const toolName = requireString(args, 'toolName');
      const toolInput = optionalObject(args, 'toolInput') ?? {};
      const toolUseId = optionalString(args, 'toolUseId');
      const session = deps.sessions.get(ctx.sessionId);
      if (!session) return errorResult(`session ${ctx.sessionId} not found`);
      const id = `${ctx.sessionId}:${randomBytes(4).toString('hex')}`;
      const decision: PermissionDecision = await new Promise((resolve) => {
        const req = {
          id,
          category: categorize(toolName),
          toolName,
          toolInput,
          toolUseId,
          resolve,
        };
        // Queue under remote session so IM listings show the pending request.
        if (session.kind === 'remote') session.addPendingPermission(req);
        deps.permissionBroker.issue(ctx.sessionId, ctx.workspaceId, req);
      });
      // Remote session's own map is cleared by resolvePendingPermission when
      // the IM frontend routes the decision back; the broker-only path used in
      // tests won't hit that, so defensively clear here too.
      if (session.kind === 'remote') {
        session.resolvePendingPermission(id, decision);
      }
      return jsonResult({
        behavior: decision === 'deny' ? 'deny' : 'allow',
        decision,
        updatedInput: toolInput,
      });
    },
  };
}
