// tests/mcp/self/tools/sessions.test.ts
//
// tlive.sessions.execute `waitFor` semantics + orchestrate real-output
// chaining. The fire-and-forget path is covered by misc.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { buildHarness, type McpTestHarness } from '../../helpers.js';
import {
  makeSessionsExecuteTool, makeSessionsOrchestrateTool,
} from '../../../../src/mcp/self/tools/sessions.js';
import type { LocalSession } from '../../../../src/session/local-session.js';
import { FakeRuntime } from '../../../session/fake-runtime.js';

function parseText(r: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(r.content[0]!.text);
}

async function spawnLocal(harness: McpTestHarness, workspaceId: string): Promise<{
  session: LocalSession; runtime: FakeRuntime;
}> {
  const session = await harness.deps.sessions.createLocal({
    workspaceId, provider: 'claude', workdir: '/W',
  });
  // FakeRuntime — one-per-session via harness.runtimeFactory in helpers.ts.
  const runtime = harness.runtimes.at(-1)!;
  return { session, runtime };
}

describe('tlive.sessions.execute — waitFor', () => {
  let harness: McpTestHarness;
  let ctx: { sessionId: string; workspaceId: string };
  let workspaceId: string;
  beforeEach(async () => {
    harness = await buildHarness();
    const ws = harness.deps.workspaces.create({ name: 'W', workdir: '/W' });
    workspaceId = ws.id;
    const r = harness.deps.sessions.registerRemote({
      sdkSessionId: 'abababab-1111-2222-3333-444444444444',
      workspaceId: ws.id, workdir: '/W', provider: 'claude',
    });
    ctx = { sessionId: r.id, workspaceId: ws.id };
  });
  afterEach(async () => { await rm(harness.root, { recursive: true, force: true }); });

  it('waitFor=complete accumulates assistant_text between turn_start and turn_end', async () => {
    const { session, runtime } = await spawnLocal(harness, workspaceId);
    const tool = makeSessionsExecuteTool(harness.deps);
    const promise = tool.handler({ alias: session.id, prompt: 'go', waitFor: 'complete' }, ctx);
    // Let the handler subscribe + call sendInput before we emit events.
    await Promise.resolve();
    await Promise.resolve();
    runtime.emitEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'go', at: Date.now() });
    runtime.emitEvent({ kind: 'assistant_text', turnId: 't1', text: 'hello', complete: true });
    runtime.emitEvent({ kind: 'assistant_text', turnId: 't1', text: ' world', complete: true });
    runtime.emitEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0.002,
      tokensIn: 3, tokensOut: 5,
    });
    const r = parseText(await promise) as {
      ok: boolean; output: string; tokensIn?: number; tokensOut?: number; costUsd?: number;
    };
    expect(r.ok).toBe(true);
    expect(r.output).toBe('hello world');
    expect(r.tokensIn).toBe(3);
    expect(r.tokensOut).toBe(5);
    expect(r.costUsd).toBe(0.002);
  });

  it('waitFor=first_response returns on the first assistant_text', async () => {
    const { session, runtime } = await spawnLocal(harness, workspaceId);
    const tool = makeSessionsExecuteTool(harness.deps);
    const promise = tool.handler({ alias: session.id, prompt: 'go', waitFor: 'first_response' }, ctx);
    await Promise.resolve();
    await Promise.resolve();
    runtime.emitEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'go', at: Date.now() });
    runtime.emitEvent({ kind: 'assistant_text', turnId: 't1', text: 'first!', complete: true });
    // Emit more — handler should already have resolved.
    runtime.emitEvent({ kind: 'assistant_text', turnId: 't1', text: 'late', complete: true });
    const r = parseText(await promise) as { ok: boolean; output: string };
    expect(r.ok).toBe(true);
    expect(r.output).toBe('first!');
  });

  it('waitFor timeout returns partial text + reason=timeout', async () => {
    const { session, runtime } = await spawnLocal(harness, workspaceId);
    const tool = makeSessionsExecuteTool(harness.deps);
    const promise = tool.handler(
      { alias: session.id, prompt: 'slow', waitFor: 'complete', timeoutMs: 25 },
      ctx,
    );
    await Promise.resolve();
    runtime.emitEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'slow', at: Date.now() });
    runtime.emitEvent({ kind: 'assistant_text', turnId: 't1', text: 'partial', complete: true });
    // No turn_end before timeout.
    const r = parseText(await promise) as { ok: boolean; output: string; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
    expect(r.output).toBe('partial');
  });

  it('fire-and-forget (no waitFor) still returns turnId', async () => {
    const { session } = await spawnLocal(harness, workspaceId);
    const tool = makeSessionsExecuteTool(harness.deps);
    const r = parseText(await tool.handler(
      { alias: session.id, prompt: 'hi' }, ctx,
    )) as { turnId: string; ok: boolean };
    expect(r.ok).toBe(true);
    expect(r.turnId.startsWith(session.id + ':')).toBe(true);
  });

  it('orchestrate: {result[0]} chains real assistant output into step 2', async () => {
    const { session: a, runtime: ra } = await spawnLocal(harness, workspaceId);
    const { session: b, runtime: rb } = await spawnLocal(harness, workspaceId);
    const tool = makeSessionsOrchestrateTool(harness.deps);
    const promise = tool.handler(
      {
        pipeline: 'inline',
        input: 'seed',
        inline: {
          name: 'p',
          steps: [
            { alias: a.id, promptTemplate: 'step1: {input}' },
            { alias: b.id, promptTemplate: 'do something with {result[0]}' },
          ],
        },
      },
      ctx,
    );

    // Step 1 — emit a response for session A.
    await Promise.resolve();
    await Promise.resolve();
    ra.emitEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'step1', at: Date.now() });
    ra.emitEvent({ kind: 'assistant_text', turnId: 't1', text: 'foo', complete: true });
    ra.emitEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0, tokensIn: 0, tokensOut: 0,
    });

    // Give the orchestrator a few microticks to advance into step 2.
    await new Promise((r) => setTimeout(r, 10));

    // Step 2 — assert b's sendInput arg was the substituted template.
    expect(rb.inputs.at(-1)).toBe('do something with foo');

    rb.emitEvent({ kind: 'turn_start', turnId: 't2', userInputPreview: 'step2', at: Date.now() });
    rb.emitEvent({ kind: 'assistant_text', turnId: 't2', text: 'bar', complete: true });
    rb.emitEvent({
      kind: 'turn_end', turnId: 't2', durationMs: 1, costUsd: 0, tokensIn: 0, tokensOut: 0,
    });

    const r = parseText(await promise) as { runId: string; outputs: string[] };
    expect(r.outputs).toEqual(['foo', 'bar']);
  });
});
