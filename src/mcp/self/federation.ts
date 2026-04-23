// src/mcp/self/federation.ts
//
// Proxy gateway. Spawns downstream MCP servers on demand, aggregates their
// tools/list with prefixed names, and routes tools/call back to them.
//
// Design notes (see spec §9.6):
// - Registry (see src/mcp/registry.ts) tells us which downstreams to manage
//   and their config (command/args/env or url/headers).
// - Lazy spawn: first `aggregateTools(workspaceId)` that lists a downstream's
//   namespace triggers spawn via `DownstreamFactory`.
// - Aggregation: tools from downstream `github` get prefixed as
//   `github.<toolName>`.
// - Routing: `call("github.create_pr", input)` strips prefix and forwards.
// - Permissions: `Registry.isAllowedForWorkspace` gates everything.
//
// `DownstreamFactory` is abstract so tests can inject fake downstream clients.

import type { McpRegistry, RegistryEntry } from '../registry.js';

export interface DownstreamToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface DownstreamClient {
  listTools: () => Promise<DownstreamToolDef[]>;
  callTool: (name: string, input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
  close: () => Promise<void>;
}

export type DownstreamFactory = (entry: RegistryEntry) => Promise<DownstreamClient>;

export interface FederationAggregateResult {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  downstream: string;
}

export class Federation {
  private readonly clients = new Map<string, DownstreamClient>();

  constructor(
    private readonly registry: McpRegistry,
    private readonly factory: DownstreamFactory,
  ) {}

  async aggregateTools(workspaceId: string): Promise<FederationAggregateResult[]> {
    const out: FederationAggregateResult[] = [];
    for (const entry of this.registry.list()) {
      if (!this.registry.isAllowedForWorkspace(entry.name, workspaceId)) continue;
      const client = await this.ensureClient(entry);
      if (!client) continue;
      try {
        const tools = await client.listTools();
        for (const t of tools) {
          out.push({
            name: `${entry.name}.${t.name}`,
            description: t.description,
            inputSchema: t.inputSchema,
            downstream: entry.name,
          });
        }
      } catch (err) {
        console.error(`[federation] listTools failed for ${entry.name}:`, err);
      }
    }
    return out;
  }

  async callTool(
    workspaceId: string,
    prefixedName: string,
    input: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null> {
    const dot = prefixedName.indexOf('.');
    if (dot <= 0) return null;
    const downstream = prefixedName.slice(0, dot);
    const rest = prefixedName.slice(dot + 1);
    if (!this.registry.isAllowedForWorkspace(downstream, workspaceId)) {
      return {
        content: [{ type: 'text', text: `federation: workspace ${workspaceId} is not allowed to call ${downstream}` }],
        isError: true,
      };
    }
    const entry = this.registry.get(downstream);
    if (!entry) return null;
    const client = await this.ensureClient(entry);
    if (!client) return null;
    return client.callTool(rest, input);
  }

  async closeAll(): Promise<void> {
    for (const [, c] of this.clients) {
      try { await c.close(); } catch { /* isolate */ }
    }
    this.clients.clear();
  }

  /**
   * Close a single downstream client and forget it. Intended for the
   * registry disable-hook (T9) so flipping enabled=false tears the
   * subprocess down; a subsequent enable=true re-spawns lazily.
   *
   * No-op (returns false) if we haven't spawned this downstream yet.
   */
  async close(name: string): Promise<boolean> {
    const client = this.clients.get(name);
    if (!client) return false;
    this.clients.delete(name);
    try { await client.close(); } catch (err) {
      console.error(`[federation] close(${name}) failed:`, err);
    }
    return true;
  }

  private async ensureClient(entry: RegistryEntry): Promise<DownstreamClient | null> {
    const cached = this.clients.get(entry.name);
    if (cached) return cached;
    try {
      const client = await this.factory(entry);
      this.clients.set(entry.name, client);
      return client;
    } catch (err) {
      console.error(`[federation] spawn failed for ${entry.name}:`, err);
      return null;
    }
  }
}
