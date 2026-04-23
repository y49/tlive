// tests/mcp/self/server.test.ts
//
// Bootstrap + initialize handshake + tools/list.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildHarness, type McpTestHarness } from '../helpers.js';
import { startTliveMcpServer, type TliveMcpServerHandle } from '../../../src/mcp/self/server.js';

describe('tlive-self MCP server', () => {
  let harness: McpTestHarness;
  let handle: TliveMcpServerHandle;
  let client: Client;

  beforeEach(async () => {
    harness = await buildHarness();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    handle = await startTliveMcpServer({
      deps: harness.deps,
      agentInfoOverride: { name: 'claude-code', cwd: '/tmp/project-x', provider: 'claude' },
      transport: serverTransport,
    });
    client = new Client({ name: 'tlive-self-test', version: '0.0.0' }, { capabilities: { sampling: {} } });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try { await client.close(); } catch { /* isolate */ }
    try { await handle.close(); } catch { /* isolate */ }
    await rm(harness.root, { recursive: true, force: true });
  });

  it('registers a RemoteSession on initialize handshake', async () => {
    expect(handle.remoteSession).not.toBeNull();
    expect(handle.remoteSession!.workdir).toBe('/tmp/project-x');
    expect(handle.remoteSession!.kind).toBe('remote');
    expect(harness.deps.workspaces.findByWorkdir('/tmp/project-x')).toBeDefined();
  });

  it('tools/list returns 20+ tools', async () => {
    const result = await client.request(
      { method: 'tools/list', params: {} },
      (await import('@modelcontextprotocol/sdk/types.js')).ListToolsResultSchema,
    );
    expect(result.tools.length).toBeGreaterThanOrEqual(20);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('tlive.approve');
    expect(names).toContain('tlive.memory.get');
    expect(names).toContain('tlive.sessions.list');
    expect(names).toContain('tlive.schedule.create');
  });

  it('tlive.user.current returns test user', async () => {
    const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const result = await client.request(
      { method: 'tools/call', params: { name: 'tlive.user.current', arguments: {} } },
      CallToolResultSchema,
    );
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text).id).toBe('test-user');
  });

  it('unknown tool returns error result, not exception', async () => {
    const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const result = await client.request(
      { method: 'tools/call', params: { name: 'not-a-tool', arguments: {} } },
      CallToolResultSchema,
    );
    expect(result.isError).toBe(true);
  });

  // Keep imports warm for typecheck.
  it('schemas import ok', () => {
    expect(CallToolRequestSchema).toBeDefined();
    expect(ListToolsRequestSchema).toBeDefined();
  });
});
