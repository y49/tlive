// src/mcp/self/tools/sessions.ts
//
// `tlive.sessions.{list, search, get, summary, execute, orchestrate}` —
// cross-session introspection + multi-agent dispatch.
//
// Notes:
// - `list` / `get` / `summary` return in-memory SessionInfo snapshots (plus
//   SessionPersistence meta when available for fallback title/summary).
// - `search` is a naive substring match over title/workdir/shortAlias. Full
//   semantic search ships with the sampling re-rank pass (spec §9.3).
// - `execute` enqueues an input on a target LocalSession (re-used to also
//   run arbitrary prompt through an existing alias).
// - `orchestrate` defers to `runPipeline` from orchestrator.ts.

import type { McpTool, McpToolDeps } from '../deps.js';
import type { LocalSession } from '../../../session/local-session.js';
import type { RemoteSession } from '../../../session/remote-session.js';
import { jsonResult, errorResult, requireString, optionalString, optionalObject } from './util.js';
import { runPipeline, loadPipeline, type Pipeline } from '../orchestrator.js';
import { awaitTurnOutput, type WaitMode, DEFAULT_AWAIT_TIMEOUT_MS } from '../session-await.js';

type AnySession = LocalSession | RemoteSession;

function resolveAlias(deps: McpToolDeps, alias: string): AnySession | null {
  const byId = deps.sessions.get(alias);
  if (byId) return byId;
  // Accept either `r-<8hex>` (RemoteSession shortAlias) or raw prefix.
  const stripped = alias.startsWith('r-') ? alias.slice(2) : alias;
  const res = deps.sessions.getByPrefix(stripped);
  return (res.resolved as AnySession | null) ?? null;
}

export function makeSessionsListTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.sessions.list',
      description: 'List live sessions across workspaces.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
        additionalProperties: false,
      },
    },
    async handler(args) {
      const workspaceId = optionalString(args, 'workspaceId');
      let infos = deps.sessions.listInfo();
      if (workspaceId) infos = infos.filter((i) => i.workspaceId === workspaceId);
      return jsonResult({ items: infos });
    },
  };
}

export function makeSessionsSearchTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.sessions.search',
      description: 'Substring search over sessions (title / workdir / alias).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async handler(args) {
      const q = requireString(args, 'query').toLowerCase();
      const workspaceId = optionalString(args, 'workspaceId');
      const hits = deps.sessions.listInfo()
        .filter((i) => !workspaceId || i.workspaceId === workspaceId)
        .filter((i) => {
          const hay = `${i.title ?? ''} ${i.shortAlias} ${i.workdir}`.toLowerCase();
          return hay.includes(q);
        });
      return jsonResult({ hits });
    },
  };
}

export function makeSessionsGetTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.sessions.get',
      description: 'Resolve a short alias (or full id) to full session detail.',
      inputSchema: {
        type: 'object',
        properties: { alias: { type: 'string' } },
        required: ['alias'],
        additionalProperties: false,
      },
    },
    async handler(args) {
      const alias = requireString(args, 'alias');
      const s = resolveAlias(deps, alias);
      if (!s) return errorResult(`session not found: ${alias}`);
      return jsonResult({ session: s.snapshot() });
    },
  };
}

export function makeSessionsSummaryTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.sessions.summary',
      description: 'One-line session summary (title + phase + cost).',
      inputSchema: {
        type: 'object',
        properties: { alias: { type: 'string' } },
        required: ['alias'],
        additionalProperties: false,
      },
    },
    async handler(args) {
      const alias = requireString(args, 'alias');
      const s = resolveAlias(deps, alias);
      if (!s) return errorResult(`session not found: ${alias}`);
      const info = s.snapshot();
      const summary = `${info.shortAlias} [${info.status.phase}] title="${info.title ?? '(untitled)'}" cost=$${info.cost.totalCost.toFixed(4)}`;
      return jsonResult({ summary });
    },
  };
}

export function makeSessionsExecuteTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.sessions.execute',
      description:
        'Send a prompt to an existing local session. Omit `waitFor` for fire-and-forget (returns a turnId). '
        + 'Pass `waitFor: "complete"` to block until turn_end and return the accumulated assistant text plus cost/tokens. '
        + 'Pass `waitFor: "first_response"` to return on the first assistant message.',
      inputSchema: {
        type: 'object',
        properties: {
          alias: { type: 'string' },
          prompt: { type: 'string' },
          waitFor: { type: 'string', enum: ['complete', 'first_response'] },
          timeoutMs: { type: 'number' },
        },
        required: ['alias', 'prompt'],
        additionalProperties: false,
      },
    },
    async handler(args) {
      const alias = requireString(args, 'alias');
      const prompt = requireString(args, 'prompt');
      const waitForRaw = optionalString(args, 'waitFor');
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_AWAIT_TIMEOUT_MS;
      const s = resolveAlias(deps, alias);
      if (!s) return errorResult(`session not found: ${alias}`);
      if (s.kind !== 'local') return errorResult(`session ${alias} is not a LocalSession`);
      // TODO(T5-followup): SessionLike should expose sendInput/onEvent
      // uniformly so this cast goes away.
      const local = s as LocalSession;
      if (!waitForRaw) {
        // Fire-and-forget — preserve the historical turnId shape.
        await local.sendInput(prompt, 'im');
        return jsonResult({ turnId: `${s.id}:${Date.now()}`, ok: true });
      }
      if (waitForRaw !== 'complete' && waitForRaw !== 'first_response') {
        return errorResult(`waitFor must be "complete" or "first_response"`);
      }
      const waitFor: WaitMode = waitForRaw;
      try {
        const r = await awaitTurnOutput(local, prompt, waitFor, timeoutMs);
        return jsonResult(r);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

export function makeSessionsOrchestrateTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.sessions.orchestrate',
      description: 'Run a named pipeline from the workspace pipelines registry.',
      inputSchema: {
        type: 'object',
        properties: {
          pipeline: { type: 'string' },
          input: {},
          inline: { type: 'object' },
        },
        required: ['pipeline'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const name = requireString(args, 'pipeline');
      const input = args.input;
      const inline = optionalObject(args, 'inline');
      const pipeline: Pipeline | null = inline
        ? (inline as unknown as Pipeline)
        : await loadPipeline(deps, ctx.workspaceId, name);
      if (!pipeline) return errorResult(`pipeline not found: ${name}`);
      const result = await runPipeline(pipeline, input, {
        executeStep: async (alias, prompt, waitFor) => {
          const s = resolveAlias(deps, alias);
          if (!s || s.kind !== 'local') throw new Error(`pipeline step: session ${alias} not found or not local`);
          // TODO(T5-followup): SessionLike should expose sendInput/onEvent
          // uniformly so this cast goes away.
          const local = s as LocalSession;
          const r = await awaitTurnOutput(local, prompt, waitFor, DEFAULT_AWAIT_TIMEOUT_MS);
          if (!r.ok && r.reason === 'timeout') {
            throw new Error(`pipeline step ${alias}: timeout waiting for ${waitFor}`);
          }
          return r.output;
        },
      });
      return jsonResult(result);
    },
  };
}
