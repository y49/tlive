// tests/session/meta-persistence.test.ts
//
// v1.0 meta-only API of SessionPersistence. The legacy snapshot tests live in
// persistence.test.ts; this file validates only the new writeMeta/loadMeta/
// loadAllMeta/deleteMeta paths.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPersistence, type SessionMeta } from '../../src/session/persistence.js';

function makeMeta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sdkSessionId: id,
    provider: 'claude',
    workspaceId: 'ws-1',
    workdir: '/p',
    createdAt: '2026-04-22T00:00:00Z',
    lastActivityAt: '2026-04-22T00:05:00Z',
    status: 'running',
    cost: { totalCost: 0.01, inputTokens: 10, outputTokens: 5 },
    pendingPermissions: [],
    pendingAskQuestions: [],
    pendingElicitations: [],
    ...extra,
  };
}

describe('SessionPersistence (meta-only API)', () => {
  let root: string;
  let p: SessionPersistence;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-meta-'));
    p = new SessionPersistence(root);
    await p.init();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('writeMeta + loadMeta roundtrip', async () => {
    const m = makeMeta('s1');
    await p.writeMeta(m);
    expect(await p.loadMeta('s1')).toEqual(m);
  });

  it('loadMeta returns null for missing', async () => {
    expect(await p.loadMeta('nope')).toBeNull();
  });

  it('loadAllMeta scans every .meta.json', async () => {
    await p.writeMeta(makeMeta('a'));
    await p.writeMeta(makeMeta('b', { status: 'stopped' }));
    const all = await p.loadAllMeta();
    expect(all.map((m) => m.sdkSessionId).sort()).toEqual(['a', 'b']);
  });

  it('loadAllMeta skips legacy snapshot files', async () => {
    await p.writeMeta(makeMeta('new'));
    await p.saveSnapshot({
      id: 'old', ctx: { sessionId: 'old', workdir: '/x', workspaceId: 'ws', workspaceName: 'x', provider: 'claude', createdAt: 1 },
      status: 'active', createdAt: 1, lastActivityAt: 2,
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      pendingPermissionIds: [],
    });
    const all = await p.loadAllMeta();
    expect(all.map((m) => m.sdkSessionId)).toEqual(['new']);
  });

  it('deleteMeta is idempotent', async () => {
    await p.writeMeta(makeMeta('s1'));
    await p.deleteMeta('s1');
    expect(await p.loadMeta('s1')).toBeNull();
    await p.deleteMeta('s1'); // second call must not throw
  });
});
