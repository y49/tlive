// src/mcp/self/tools/policy.ts
//
// `tlive.policy.{suggest,add,list,remove}` — wire workspace PolicyStore to
// MCP. Learned allow/deny rules auto-resolve future permission requests.

import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult, requireString, optionalString, optionalObject } from './util.js';
import type { PolicyRule } from '../../../permission/policy-store.js';

export function makePolicySuggestTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.policy.suggest',
      description: 'Suggest policy rules for recent permission requests (trivial heuristic for now).',
      inputSchema: {
        type: 'object',
        properties: { recent: { type: 'array' } },
        additionalProperties: false,
      },
    },
    async handler(args) {
      const recent = Array.isArray(args.recent) ? args.recent : [];
      const suggestions = recent
        .filter((r): r is { toolName?: unknown; repeated?: unknown } => typeof r === 'object' && r !== null)
        .filter((r) => typeof r.toolName === 'string' && typeof r.repeated === 'number' && r.repeated >= 3)
        .map((r) => ({
          pattern: { toolName: r.toolName as string },
          decision: 'allow' as const,
          scope: 'workspace' as const,
          rationale: `Observed ${r.repeated as number} repeated allows for ${r.toolName as string}`,
        }));
      return jsonResult({ suggestions });
    },
  };
}

export function makePolicyAddTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.policy.add',
      description: 'Register an allow/deny rule for the calling workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'object' },
          decision: { type: 'string', enum: ['allow', 'deny'] },
          scope: { type: 'string', enum: ['workspace', 'session'] },
        },
        required: ['pattern', 'decision'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const pattern = optionalObject(args, 'pattern') ?? {};
      const decision = requireString(args, 'decision') as 'allow' | 'deny';
      const scope = (optionalString(args, 'scope') ?? 'workspace') as 'workspace' | 'session';
      if (decision !== 'allow' && decision !== 'deny') return errorResult('decision must be allow | deny');
      const store = deps.policyStoreFor(ctx.workspaceId);
      await store.load();
      const rule = await store.add(pattern as PolicyRule['pattern'], decision, scope, deps.user().id);
      return jsonResult({ id: rule.id, rule });
    },
  };
}

export function makePolicyListTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.policy.list',
      description: 'List policy rules for the calling workspace.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async handler(_args, ctx) {
      const store = deps.policyStoreFor(ctx.workspaceId);
      await store.load();
      return jsonResult({ rules: store.list() });
    },
  };
}

export function makePolicyRemoveTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.policy.remove',
      description: 'Remove a policy rule by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const id = requireString(args, 'id');
      const store = deps.policyStoreFor(ctx.workspaceId);
      await store.load();
      const ok = await store.remove(id);
      return jsonResult({ ok });
    },
  };
}
