// tests/mcp/self/tools/approve.test.ts
//
// Exercise tlive.approve through the broker. Simulates IM resolving the
// pending request and asserts the tool handler completes with the decision.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { buildHarness, type McpTestHarness } from '../../helpers.js';
import { makeApproveTool } from '../../../../src/mcp/self/tools/approve.js';

describe('tlive.approve tool', () => {
  let harness: McpTestHarness;
  let ctx: { sessionId: string; workspaceId: string };

  beforeEach(async () => {
    harness = await buildHarness();
    const ws = harness.deps.workspaces.create({ name: 't', workdir: '/t' });
    const remote = harness.deps.sessions.registerRemote({
      sdkSessionId: 'remote-1234-0000-0000-0000-000000000000',
      workspaceId: ws.id, workdir: '/t', provider: 'claude',
    });
    ctx = { sessionId: remote.id, workspaceId: ws.id };
  });

  afterEach(async () => { await rm(harness.root, { recursive: true, force: true }); });

  it('round-trips through the PermissionBroker', async () => {
    const tool = makeApproveTool(harness.deps);
    const invocation = tool.handler({ toolName: 'Bash', toolInput: { cmd: 'ls' } }, ctx);

    // Wait a tick for the broker to have the pending entry.
    await Promise.resolve();
    const pending = harness.deps.permissionBroker.pendingFor(ctx.sessionId);
    expect(pending).toHaveLength(1);
    const id = pending[0]!.id;
    const resolved = harness.deps.permissionBroker.resolve(ctx.sessionId, id, 'allow', 'user-1');
    expect(resolved).toBe(true);

    const result = await invocation;
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.behavior).toBe('allow');
    expect(payload.decision).toBe('allow');
  });

  it('auto-resolves against a PolicyStore rule without opening a pending request', async () => {
    const store = harness.deps.policyStoreFor(ctx.workspaceId);
    await store.load();
    await store.add({ toolName: 'Bash' }, 'allow', 'workspace', 'test');
    // Rebuild broker with policy lookup.
    const { PermissionBroker } = await import('../../../../src/permission/broker.js');
    const broker = new PermissionBroker({ policyStoreFor: (id) => (id === ctx.workspaceId ? store : undefined) });
    const deps = { ...harness.deps, permissionBroker: broker };
    const tool = makeApproveTool(deps);
    const result = await tool.handler({ toolName: 'Bash', toolInput: {} }, ctx);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.decision).toBe('allow');
    expect(broker.pendingCount()).toBe(0);
  });
});
