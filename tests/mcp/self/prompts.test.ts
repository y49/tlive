// tests/mcp/self/prompts.test.ts
//
// Prompt registry assembles dynamic content.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { buildHarness, type McpTestHarness } from '../helpers.js';
import { PromptRegistry } from '../../../src/mcp/self/prompts.js';

describe('PromptRegistry', () => {
  let harness: McpTestHarness;
  beforeEach(async () => { harness = await buildHarness(); });
  afterEach(async () => { await rm(harness.root, { recursive: true, force: true }); });

  it('list returns all six templates', () => {
    const reg = new PromptRegistry(harness.deps);
    const names = reg.list().map((p) => p.name);
    expect(names).toEqual([
      'tlive-daily-standup',
      'tlive-review-session',
      'tlive-cross-search',
      'tlive-team-digest',
      'tlive-explain-error',
      'tlive-continue-plan',
    ]);
  });

  it('daily-standup bakes in session info', async () => {
    const ws = harness.deps.workspaces.create({ name: 'w', workdir: '/w' });
    harness.deps.sessions.registerRemote({
      sdkSessionId: 'cccccccc-1111-2222-3333-444444444444',
      workspaceId: ws.id, workdir: '/w', provider: 'claude', title: 'Fix flaky test',
    });
    const reg = new PromptRegistry(harness.deps);
    const res = await reg.get('tlive-daily-standup', {}, ws.id);
    expect(res!.messages[0]!.content.text).toContain('Fix flaky test');
  });

  it('cross-search filters by query', async () => {
    const ws = harness.deps.workspaces.create({ name: 'w', workdir: '/w' });
    harness.deps.sessions.registerRemote({
      sdkSessionId: 'dddddddd-1111-2222-3333-444444444444',
      workspaceId: ws.id, workdir: '/w', provider: 'claude', title: 'refactor auth',
    });
    const reg = new PromptRegistry(harness.deps);
    const res = await reg.get('tlive-cross-search', { query: 'auth' }, ws.id);
    expect(res!.messages[0]!.content.text).toContain('refactor auth');
  });

  it('unknown prompt returns null', async () => {
    const reg = new PromptRegistry(harness.deps);
    expect(await reg.get('not-a-prompt', {}, 'ws-1')).toBeNull();
  });
});
