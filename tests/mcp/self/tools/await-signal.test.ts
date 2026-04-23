// tests/mcp/self/tools/await-signal.test.ts
//
// Long-poll unblocks when a signal is emitted. Times out cleanly when none.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { buildHarness, type McpTestHarness } from '../../helpers.js';
import { makeAwaitSignalTool, makeAwaitUserInputTool } from '../../../../src/mcp/self/tools/await-signal.js';

describe('await_signal / await_user_input tools', () => {
  let harness: McpTestHarness;
  beforeEach(async () => { harness = await buildHarness(); });
  afterEach(async () => { await rm(harness.root, { recursive: true, force: true }); });

  it('unblocks when matching signal emitted', async () => {
    const ctx = { sessionId: 's1', workspaceId: 'w1' };
    const tool = makeAwaitSignalTool(harness.deps);
    const pending = tool.handler({ kind: 'interrupt', timeoutMs: 2000 }, ctx);
    // Yield microtasks so the waiter is registered
    await Promise.resolve();
    harness.signals.emit('s1', 'interrupt', { note: 'stop' });
    const result = await pending;
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.signal.kind).toBe('interrupt');
    expect(payload.signal.payload.note).toBe('stop');
  });

  it('times out → null signal', async () => {
    const ctx = { sessionId: 's1', workspaceId: 'w1' };
    const tool = makeAwaitSignalTool(harness.deps);
    const result = await tool.handler({ kind: 'user_input', timeoutMs: 10 }, ctx);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.signal).toBeNull();
  });

  it('await_user_input returns payload text', async () => {
    const ctx = { sessionId: 's2', workspaceId: 'w1' };
    const tool = makeAwaitUserInputTool(harness.deps);
    const pending = tool.handler({ timeoutMs: 2000 }, ctx);
    await Promise.resolve();
    harness.signals.emit('s2', 'user_input', 'hi');
    const result = await pending;
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.input).toBe('hi');
  });
});
