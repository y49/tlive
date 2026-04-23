// tests/mcp/self/tools/misc.test.ts
//
// Smoke coverage for memory, artifact, notify, workspace, user, sync, handoff,
// policy, sessions, ask, schedule tools driven directly (no MCP transport).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { buildHarness, type McpTestHarness } from '../../helpers.js';
import { makeMemoryGetTool, makeMemorySetTool, makeMemoryListTool } from '../../../../src/mcp/self/tools/memory.js';
import { makeArtifactUploadTool, makeArtifactListTool } from '../../../../src/mcp/self/tools/artifact.js';
import { makeNotifyImTool } from '../../../../src/mcp/self/tools/notify.js';
import { makeWorkspaceInfoTool } from '../../../../src/mcp/self/tools/workspace.js';
import { makeUserCurrentTool } from '../../../../src/mcp/self/tools/user.js';
import { makeSyncStateTool } from '../../../../src/mcp/self/tools/sync.js';
import { makeHandoffReleaseTool, makeHandoffTakeTool } from '../../../../src/mcp/self/tools/handoff.js';
import {
  makePolicyAddTool, makePolicyListTool, makePolicyRemoveTool, makePolicySuggestTool,
} from '../../../../src/mcp/self/tools/policy.js';
import {
  makeSessionsListTool, makeSessionsGetTool, makeSessionsSearchTool, makeSessionsSummaryTool,
} from '../../../../src/mcp/self/tools/sessions.js';
import { makeAskRemoteTool } from '../../../../src/mcp/self/tools/ask.js';
import {
  makeScheduleCreateTool, makeScheduleListTool, makeScheduleRemoveTool,
} from '../../../../src/mcp/self/tools/schedule.js';
import { resetCronEngineForTests } from '../../../../src/mcp/self/cron.js';

function parseText(r: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(r.content[0]!.text);
}

describe('misc tool smoke tests', () => {
  let harness: McpTestHarness;
  let ctx: { sessionId: string; workspaceId: string };
  beforeEach(async () => {
    resetCronEngineForTests();
    harness = await buildHarness();
    const ws = harness.deps.workspaces.create({ name: 'W', workdir: '/W' });
    const r = harness.deps.sessions.registerRemote({
      sdkSessionId: 'abababab-1111-2222-3333-444444444444',
      workspaceId: ws.id, workdir: '/W', provider: 'claude',
    });
    ctx = { sessionId: r.id, workspaceId: ws.id };
  });
  afterEach(async () => { await rm(harness.root, { recursive: true, force: true }); });

  it('memory set / get / list round-trip', async () => {
    await makeMemorySetTool(harness.deps).handler({ key: 'note', value: { a: 1 } }, ctx);
    const got = parseText(await makeMemoryGetTool(harness.deps).handler({ key: 'note' }, ctx));
    expect((got as { value: unknown }).value).toEqual({ a: 1 });
    const list = parseText(await makeMemoryListTool(harness.deps).handler({}, ctx));
    expect((list as { items: { key: string }[] }).items[0]!.key).toBe('note');
  });

  it('memory reject bogus key', async () => {
    const r = await makeMemorySetTool(harness.deps).handler({ key: '../evil', value: 1 }, ctx);
    expect(r.isError).toBe(true);
  });

  it('artifact upload + list', async () => {
    const b64 = Buffer.from('hello').toString('base64');
    const r = await makeArtifactUploadTool(harness.deps).handler({ name: 'f.txt', content_base64: b64, mime: 'text/plain' }, ctx);
    const uploaded = parseText(r) as { id: string };
    expect(uploaded.id).toBeTruthy();
    const list = parseText(await makeArtifactListTool(harness.deps).handler({}, ctx)) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
  });

  it('notify forwards to IM', async () => {
    await makeNotifyImTool(harness.deps).handler({ text: 'hi', urgency: 'high' }, ctx);
    expect(harness.notifiedMessages.at(-1)).toMatchObject({ text: 'hi' });
  });

  it('workspace.info returns workspace state', async () => {
    const r = await makeWorkspaceInfoTool(harness.deps).handler({}, ctx);
    const info = parseText(r) as { id: string };
    expect(info.id).toBe(ctx.workspaceId);
  });

  it('user.current returns harness identity', async () => {
    const r = await makeUserCurrentTool(harness.deps).handler({}, ctx);
    const info = parseText(r) as { id: string };
    expect(info.id).toBe('test-user');
  });

  it('sync.state updates remote phase', async () => {
    const r = await makeSyncStateTool(harness.deps).handler({ phase: 'thinking', detail: { currentTool: 'Read' } }, ctx);
    expect(r.isError).toBeFalsy();
    const snap = harness.deps.sessions.get(ctx.sessionId)!.snapshot();
    expect(snap.status.phase).toBe('thinking');
  });

  it('handoff release / take against workspace slot', async () => {
    const take = await makeHandoffTakeTool(harness.deps).handler({ sdkId: ctx.sessionId }, ctx);
    expect(take.isError).toBeFalsy();
    expect(harness.deps.workspaces.getActiveSessionId(ctx.workspaceId)).toBe(ctx.sessionId);
    const rel = await makeHandoffReleaseTool(harness.deps).handler({}, ctx);
    expect(rel.isError).toBeFalsy();
    expect(harness.deps.workspaces.getActiveSessionId(ctx.workspaceId)).toBeNull();
  });

  it('policy add / list / remove', async () => {
    const added = parseText(await makePolicyAddTool(harness.deps).handler({
      pattern: { toolName: 'Bash' }, decision: 'allow', scope: 'workspace',
    }, ctx)) as { id: string };
    const list = parseText(await makePolicyListTool(harness.deps).handler({}, ctx)) as { rules: unknown[] };
    expect(list.rules).toHaveLength(1);
    const removed = parseText(await makePolicyRemoveTool(harness.deps).handler({ id: added.id }, ctx));
    expect((removed as { ok: boolean }).ok).toBe(true);
  });

  it('policy suggest emits allow for repeated hits', async () => {
    const r = await makePolicySuggestTool(harness.deps).handler({
      recent: [{ toolName: 'Bash', repeated: 5 }, { toolName: 'Read', repeated: 1 }],
    }, ctx);
    const { suggestions } = parseText(r) as { suggestions: Array<{ pattern: { toolName: string } }> };
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.pattern.toolName).toBe('Bash');
  });

  it('sessions list / get / search / summary', async () => {
    const list = parseText(await makeSessionsListTool(harness.deps).handler({}, ctx)) as { items: unknown[] };
    expect(list.items.length).toBeGreaterThan(0);
    const got = parseText(await makeSessionsGetTool(harness.deps).handler({ alias: ctx.sessionId }, ctx)) as { session: { id: string } };
    expect(got.session.id).toBe(ctx.sessionId);
    const short = harness.deps.sessions.get(ctx.sessionId)!.shortAlias;
    const search = parseText(await makeSessionsSearchTool(harness.deps).handler({ query: short.slice(2, 6) }, ctx)) as { hits: unknown[] };
    expect(search.hits.length).toBeGreaterThan(0);
    const sum = parseText(await makeSessionsSummaryTool(harness.deps).handler({ alias: ctx.sessionId }, ctx)) as { summary: string };
    expect(sum.summary).toContain(short);
  });

  it('ask.remote resolves via broker', async () => {
    const tool = makeAskRemoteTool(harness.deps);
    const invocation = tool.handler({ prompt: 'pick', options: ['a', 'b'], timeoutMs: 1000 }, ctx);
    await Promise.resolve();
    const pending = harness.deps.askBroker.pendingFor(ctx.sessionId);
    expect(pending).toHaveLength(1);
    harness.deps.askBroker.resolve(ctx.sessionId, pending[0]!.id, ['a']);
    const result = parseText(await invocation) as { chosen: string[] };
    expect(result.chosen).toEqual(['a']);
  });

  it('ask.remote times out to []', async () => {
    const tool = makeAskRemoteTool(harness.deps);
    const r = await tool.handler({ prompt: 'x', options: ['y'], timeoutMs: 10 }, ctx);
    expect((parseText(r) as { chosen: string[] }).chosen).toEqual([]);
  });

  it('schedule create / list / remove', async () => {
    const created = parseText(await makeScheduleCreateTool(harness.deps).handler({
      daily: '09:00', prompt: 'standup',
    }, ctx)) as { id: string };
    const list = parseText(await makeScheduleListTool(harness.deps).handler({}, ctx)) as { tasks: unknown[] };
    expect(list.tasks).toHaveLength(1);
    const rm = parseText(await makeScheduleRemoveTool(harness.deps).handler({ id: created.id }, ctx)) as { ok: boolean };
    expect(rm.ok).toBe(true);
  });
});
