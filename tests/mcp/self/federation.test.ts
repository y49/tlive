// tests/mcp/self/federation.test.ts
//
// Prefix routing + lazy spawn + workspace scoping.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Federation, type DownstreamClient } from '../../../src/mcp/self/federation.js';
import { McpRegistry } from '../../../src/mcp/registry.js';

describe('Federation', () => {
  let root: string;
  let registry: McpRegistry;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-fed-'));
    registry = new McpRegistry({ file: join(root, 'mcp-registry.json') });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function fakeClient(name: string): DownstreamClient {
    return {
      listTools: vi.fn().mockResolvedValue([{ name: 'create_pr', description: 'create pr', inputSchema: { type: 'object' } }]),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: `called:${name}` }] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('aggregates downstream tools with name prefix', async () => {
    await registry.add({ name: 'github', config: { command: 'node', args: [] }, enabled: true });
    const fac = vi.fn().mockImplementation((e) => fakeClient(e.name));
    const fed = new Federation(registry, fac);
    const agg = await fed.aggregateTools('ws-1');
    expect(agg).toHaveLength(1);
    expect(agg[0]!.name).toBe('github.create_pr');
    expect(agg[0]!.downstream).toBe('github');
  });

  it('lazy-spawns only once per downstream', async () => {
    await registry.add({ name: 'github', config: { command: 'node', args: [] }, enabled: true });
    const fac = vi.fn().mockImplementation((e) => fakeClient(e.name));
    const fed = new Federation(registry, fac);
    await fed.aggregateTools('ws-1');
    await fed.aggregateTools('ws-1');
    expect(fac).toHaveBeenCalledTimes(1);
  });

  it('strips prefix and forwards to downstream on call', async () => {
    await registry.add({ name: 'github', config: { command: 'node' }, enabled: true });
    const clients: DownstreamClient[] = [];
    const fac = vi.fn().mockImplementation((e) => {
      const c = fakeClient(e.name); clients.push(c); return c;
    });
    const fed = new Federation(registry, fac);
    const result = await fed.callTool('ws-1', 'github.create_pr', { title: 'T' });
    expect(result!.content[0]!.text).toBe('called:github');
    expect((clients[0]!.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('create_pr', { title: 'T' });
  });

  it('rejects call from disallowed workspace', async () => {
    await registry.add({ name: 'github', config: { command: 'node' }, enabled: true, workspaceIds: ['ws-allowed'] });
    const fac = vi.fn().mockImplementation((e) => fakeClient(e.name));
    const fed = new Federation(registry, fac);
    const result = await fed.callTool('ws-other', 'github.create_pr', {});
    expect(result!.isError).toBe(true);
    expect(fac).not.toHaveBeenCalled();
  });

  it('disabled downstream is not listed', async () => {
    await registry.add({ name: 'github', config: { command: 'node' }, enabled: false });
    const fac = vi.fn().mockImplementation((e) => fakeClient(e.name));
    const fed = new Federation(registry, fac);
    const agg = await fed.aggregateTools('ws-1');
    expect(agg).toHaveLength(0);
  });
});
