// tests/mcp/self/resources.test.ts
//
// URI parser + resource read paths.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildHarness, type McpTestHarness } from '../helpers.js';
import { parseUri, ResourceProvider } from '../../../src/mcp/self/resources.js';

describe('ResourceProvider', () => {
  let harness: McpTestHarness;
  beforeEach(async () => { harness = await buildHarness(); });
  afterEach(async () => { await rm(harness.root, { recursive: true, force: true }); });

  it('parseUri handles every documented form', () => {
    expect(parseUri('tlive://sessions/')!.kind).toBe('sessions_dir');
    expect(parseUri('tlive://sessions/abc/transcript.md')!.kind).toBe('session_transcript');
    expect(parseUri('tlive://sessions/abc/meta.json')!.kind).toBe('session_meta');
    expect(parseUri('tlive://sessions/abc/todos.md')!.kind).toBe('session_todos');
    expect(parseUri('tlive://workspace/W/config.json')!.workspaceId).toBe('W');
    expect(parseUri('tlive://workspace/W/memory/foo')!.memoryKey).toBe('foo');
    expect(parseUri('tlive://workspace/W/summary/2026-04-22.md')!.summaryDate).toBe('2026-04-22');
    expect(parseUri('tlive://activity/last-24h')!.kind).toBe('activity_24h');
    expect(parseUri('tlive://activity/week')!.kind).toBe('activity_week');
    expect(parseUri('http://example.com')).toBeNull();
    expect(parseUri('tlive://bogus')).toBeNull();
  });

  it('reads workspace config + memory + summary', async () => {
    const ws = harness.deps.workspaces.create({ name: 'x', workdir: '/x' });
    const memDir = join(harness.root, 'workspaces', ws.id, 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, 'k.json'), JSON.stringify({ v: 1 }), 'utf8');
    const sumDir = join(harness.root, 'workspaces', ws.id, 'summary');
    await mkdir(sumDir, { recursive: true });
    await writeFile(join(sumDir, '2026-04-22.md'), '# hi', 'utf8');

    const rp = new ResourceProvider(harness.deps);
    const cfg = await rp.read(`tlive://workspace/${ws.id}/config.json`);
    expect(cfg!.mimeType).toBe('application/json');
    const mem = await rp.read(`tlive://workspace/${ws.id}/memory/k`);
    expect(JSON.parse(mem!.text)).toEqual({ v: 1 });
    const sum = await rp.read(`tlive://workspace/${ws.id}/summary/2026-04-22.md`);
    expect(sum!.text).toBe('# hi');
  });

  it('reads session meta after registerRemote', async () => {
    const ws = harness.deps.workspaces.create({ name: 'y', workdir: '/y' });
    const remote = harness.deps.sessions.registerRemote({
      sdkSessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      workspaceId: ws.id, workdir: '/y', provider: 'claude',
    });
    const rp = new ResourceProvider(harness.deps);
    const meta = await rp.read(`tlive://sessions/${remote.shortAlias}/meta.json`);
    const parsed = JSON.parse(meta!.text);
    expect(parsed.id).toBe(remote.id);
    expect(parsed.kind).toBe('remote');
  });

  it('list() contains sessions + workspaces + activity URIs', async () => {
    const ws = harness.deps.workspaces.create({ name: 'z', workdir: '/z' });
    harness.deps.sessions.registerRemote({
      sdkSessionId: 'bbbbbbbb-1111-2222-3333-444444444444',
      workspaceId: ws.id, workdir: '/z', provider: 'claude',
    });
    const rp = new ResourceProvider(harness.deps);
    const items = await rp.list();
    const uris = items.map((i) => i.uri);
    expect(uris).toContain('tlive://sessions/');
    expect(uris).toContain('tlive://activity/last-24h');
    expect(uris).toContain('tlive://activity/week');
    expect(uris.some((u) => u.includes(`workspace/${ws.id}/config.json`))).toBe(true);
  });
});
