// tests/integration/mcp-proxy-federation.test.ts
//
// Federation proxy end-to-end: register a downstream MCP server, confirm its
// tools appear under the prefixed namespace, and that tools/call routes back
// to the downstream. Workspace scoping is exercised (unlisted workspaces
// can't invoke a gated downstream).
//
// Focus here is the integration shape — unit-level Federation behavior is
// already covered in tests/mcp/self/federation.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpRegistry } from '../../src/mcp/registry.js';
import { Federation, type DownstreamClient } from '../../src/mcp/self/federation.js';

describe('integration: mcp-proxy-federation', () => {
  let root: string;
  let registry: McpRegistry;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-fed-int-'));
    registry = new McpRegistry({ file: join(root, 'mcp-registry.json') });
    await registry.load();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function downstream(name: string): DownstreamClient {
    return {
      listTools: vi.fn().mockResolvedValue([
        { name: 'create_issue', description: `create issue via ${name}`, inputSchema: { type: 'object' } },
        { name: 'search', description: `search ${name}`, inputSchema: { type: 'object' } },
      ]),
      callTool: vi.fn().mockImplementation(async (toolName, input) => ({
        content: [{ type: 'text', text: `${name}.${toolName}(${JSON.stringify(input)})` }],
      })),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('registered downstream tools appear prefixed; call routes to the correct one; workspace gate enforced', async () => {
    await registry.add({ name: 'github', config: { command: 'node' }, enabled: true });
    await registry.add({ name: 'linear', config: { command: 'node' }, enabled: true, workspaceIds: ['ws-allowed'] });

    const clients = new Map<string, DownstreamClient>();
    const factory = vi.fn().mockImplementation((entry) => {
      const c = downstream(entry.name); clients.set(entry.name, c); return c;
    });

    const fed = new Federation(registry, factory);

    // Aggregate under an allowed workspace — both downstreams should surface.
    const aggAllowed = await fed.aggregateTools('ws-allowed');
    const allowedNames = aggAllowed.map((t) => t.name).sort();
    expect(allowedNames).toEqual([
      'github.create_issue', 'github.search', 'linear.create_issue', 'linear.search',
    ]);

    // A disallowed workspace only sees github (linear is scoped out).
    const aggOther = await fed.aggregateTools('ws-other');
    const otherNames = aggOther.map((t) => t.name).sort();
    expect(otherNames).toEqual(['github.create_issue', 'github.search']);

    // tools/call — prefix stripped and routed to the right downstream.
    const r1 = await fed.callTool('ws-allowed', 'github.create_issue', { title: 'bug' });
    expect(r1!.content[0]!.text).toContain('github.create_issue');
    const r2 = await fed.callTool('ws-allowed', 'linear.search', { q: 'flaky' });
    expect(r2!.content[0]!.text).toContain('linear.search');

    // Gated downstream from disallowed workspace returns isError.
    const denied = await fed.callTool('ws-other', 'linear.create_issue', {});
    expect(denied!.isError).toBe(true);
    // Lazy-spawn: factory called exactly once per downstream across the above calls.
    expect(factory).toHaveBeenCalledTimes(2);

    // Teardown closes every spawned downstream exactly once.
    await fed.closeAll();
    for (const c of clients.values()) {
      expect(c.close).toHaveBeenCalledTimes(1);
    }
  });
});
