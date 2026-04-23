import { describe, it, expect, vi } from 'vitest';
import { mcpCmd } from '../../../src/im/commands/mcp.js';
import type { McpRegistry } from '../../../src/mcp/registry.js';
import { buildCtx } from './_helpers.js';

describe('/mcp', () => {
  it('reports missing registry', async () => {
    const { ctx, replies } = buildCtx();
    await mcpCmd.run(ctx, ['list']);
    expect(replies[0]).toMatch(/McpRegistry not wired/);
  });

  it('list entries', async () => {
    const { ctx, replies } = buildCtx();
    ctx.mcpRegistry = {
      list: () => [{ name: 'srv1', config: { type: 'stdio' }, enabled: true }],
      add: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(),
    } as unknown as McpRegistry;
    await mcpCmd.run(ctx, ['list']);
    expect(replies[0]).toContain('srv1');
  });

  it('add parses JSON', async () => {
    const add = vi.fn(async () => undefined);
    const { ctx, replies } = buildCtx();
    ctx.mcpRegistry = {
      list: () => [], add, remove: vi.fn(), setEnabled: vi.fn(),
    } as unknown as McpRegistry;
    await mcpCmd.run(ctx, ['add', '{"name":"s","config":{"type":"stdio"}}']);
    expect(add).toHaveBeenCalled();
    expect(replies[0]).toMatch(/Added MCP server/);
  });
});
