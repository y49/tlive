// src/mcp/self/server.ts
//
// tlive-self MCP server. Stdio transport with full Server API:
// tools/list, tools/call, resources/list, resources/read, resources/subscribe,
// prompts/list, prompts/get, plus client sampling capability.
//
// Initialize handshake: we read the calling agent's cwd (process.env.PWD or
// CLAUDE_CWD or TLIVE_CWD) and look up the matching workspace. If none, the
// workspace is auto-created. A RemoteSession is registered keyed by the
// generated sdkSessionId so every subsequent tool call can find it through
// the shared SessionManager.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { McpToolDeps, ToolCallCtx } from './deps.js';
import { buildToolRegistry, indexByName } from './tools/index.js';
import { ResourceProvider } from './resources.js';
import { PromptRegistry } from './prompts.js';
import type { SamplingClient } from './sampling.js';
import type { Federation } from './federation.js';
import type { RemoteSession } from '../../session/remote-session.js';
import type { NotificationEvent } from '../../runtime/events.js';

export interface TliveMcpServerOptions {
  deps: McpToolDeps;
  federation?: Federation;
  /** Agent info override — production reads from initialize.clientInfo. */
  agentInfoOverride?: { name: string; cwd: string; provider?: 'claude' | 'codex' };
  /** Inject a transport (tests use in-memory; prod uses stdio). */
  transport?: Transport;
}

export interface TliveMcpServerHandle {
  server: Server;
  close: () => Promise<void>;
  /** Exposed for tests: current bound remote session. */
  remoteSession: RemoteSession | null;
  samplingClient: SamplingClient;
}

/**
 * Start a tlive-self MCP server. Returns a handle whose `close()` unwinds
 * everything (transport, registered remote session, resource subscriptions).
 */
export async function startTliveMcpServer(opts: TliveMcpServerOptions): Promise<TliveMcpServerHandle> {
  const deps = opts.deps;
  const tools = buildToolRegistry(deps);
  const toolIndex = indexByName(tools);
  const resourceProvider = new ResourceProvider(deps);
  const prompts = new PromptRegistry(deps);

  const server = new Server(
    { name: 'tlive-self', version: '1.0.0' },
    {
      // Sampling is a *client* capability — we call into it, we don't declare
      // it. We advertise tools / resources / prompts here.
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
      },
    },
  );

  // Sampling client — lazy-check client capability at call time.
  const samplingClient: SamplingClient = {
    supported() {
      const caps = server.getClientCapabilities();
      return !!caps?.sampling;
    },
    async createMessage(params) {
      const result = await server.createMessage({
        messages: params.messages.map((m) => ({
          role: m.role,
          content: Array.isArray(m.content) ? m.content[0]! : m.content,
        })),
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        stopSequences: params.stopSequences,
        systemPrompt: params.systemPrompt,
      });
      return { content: result.content as { type: string; text?: string }, stopReason: result.stopReason ?? 'end_turn' };
    },
  };

  // ---- RemoteSession wiring (auto-register on `initialize`) -----------------
  let remoteSession: RemoteSession | null = null;

  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    const override = opts.agentInfoOverride;
    const cwd = override?.cwd ?? process.env.TLIVE_CWD ?? process.env.PWD ?? process.cwd();
    const provider = override?.provider ?? 'claude';
    const workspace = deps.workspaces.findByWorkdir(cwd) ?? deps.workspaces.ensureForWorkdir(cwd, provider);
    const sdkSessionId = randomUUID();
    remoteSession = deps.sessions.registerRemote({
      sdkSessionId,
      workspaceId: workspace.id,
      workdir: cwd,
      provider,
      title: clientInfo?.name ? `via ${clientInfo.name}` : undefined,
    });
  };

  // ---- Tool handlers --------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const defs = tools.map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      inputSchema: t.definition.inputSchema,
    }));
    let federated: ReturnType<typeof tools.map> = [];
    if (opts.federation && remoteSession) {
      const agg = await opts.federation.aggregateTools(remoteSession.workspaceId);
      federated = agg.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as never,
      }));
    }
    return { tools: [...defs, ...federated] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<never> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const ctx: ToolCallCtx = resolveCtx(remoteSession);
    // Federation dispatch: names containing a `.` with a known downstream prefix.
    if (opts.federation && name.includes('.') && !toolIndex.has(name)) {
      const result = await opts.federation.callTool(ctx.workspaceId, name, args);
      if (result) return result as unknown as never;
    }
    const tool = toolIndex.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true } as unknown as never;
    }
    try {
      const r = await tool.handler(args, ctx);
      return r as unknown as never;
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true } as unknown as never;
    }
  });

  // ---- Resources ------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const items = await resourceProvider.list();
    return { resources: items };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const content = await resourceProvider.read(uri);
    if (!content) throw new Error(`unknown resource: ${uri}`);
    return { contents: [content] };
  });

  const subscriptions = new Map<string, () => void>();
  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (subscriptions.has(uri)) return {};
    const unsub = resourceProvider.subscribe(uri, (ev: NotificationEvent) => {
      server.sendResourceUpdated({ uri }).catch(() => undefined);
      void ev;
    });
    if (!unsub) throw new Error(`resource ${uri} does not support subscribe`);
    subscriptions.set(uri, unsub);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    const unsub = subscriptions.get(uri);
    if (unsub) { unsub(); subscriptions.delete(uri); }
    return {};
  });

  // ---- Prompts --------------------------------------------------------------

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: prompts.list() };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req): Promise<never> => {
    const ctx = resolveCtx(remoteSession);
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    const result = await prompts.get(req.params.name, args, ctx.workspaceId);
    if (!result) throw new Error(`unknown prompt: ${req.params.name}`);
    return result as unknown as never;
  });

  const transport = opts.transport ?? new StdioServerTransport();
  await server.connect(transport);

  return {
    server,
    samplingClient,
    get remoteSession() { return remoteSession; },
    async close() {
      for (const unsub of subscriptions.values()) try { unsub(); } catch { /* isolate */ }
      subscriptions.clear();
      if (remoteSession) {
        deps.sessions.stop(remoteSession.id).catch(() => undefined);
      }
      await server.close();
    },
  };
}

function resolveCtx(remoteSession: RemoteSession | null): ToolCallCtx {
  if (!remoteSession) {
    throw new Error('tlive-self server: no RemoteSession bound (initialize handshake missed)');
  }
  return {
    sessionId: remoteSession.id,
    workspaceId: remoteSession.workspaceId,
    shortAlias: remoteSession.shortAlias,
  };
}
