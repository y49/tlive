import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPersistence, type SessionSnapshot } from '../../src/session/persistence.js';
import type { NotificationEvent } from '../../src/runtime/events.js';

function makeSnap(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    ctx: { sessionId: id, workdir: '/x', workspaceId: 'ws', workspaceName: 'x',
           provider: 'claude', createdAt: 1 },
    status: 'active',
    createdAt: 1,
    lastActivityAt: 2,
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    pendingPermissionIds: [],
    ...overrides,
  };
}

describe('SessionPersistence', () => {
  let root: string;
  let p: SessionPersistence;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-persist-'));
    p = new SessionPersistence(root);
    await p.init();
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('loadSnapshot returns null for missing session', async () => {
    expect(await p.loadSnapshot('nope')).toBeNull();
  });

  it('saveSnapshot + loadSnapshot round-trips', async () => {
    const snap = makeSnap('s1');
    await p.saveSnapshot(snap);
    expect(await p.loadSnapshot('s1')).toEqual(snap);
  });

  it('appendEvent accumulates and loadHistory reads back in order', async () => {
    const e1: NotificationEvent = { kind: 'heartbeat', elapsedMs: 0 };
    const e2: NotificationEvent = { kind: 'assistant_text', turnId: 't1', text: 'hi', complete: true };
    await p.appendEvent('s1', e1);
    await p.appendEvent('s1', e2);
    expect(await p.loadHistory('s1')).toEqual([e1, e2]);
  });

  it('loadHistory returns [] for missing history file', async () => {
    expect(await p.loadHistory('ghost')).toEqual([]);
  });

  it('loadHistory skips malformed lines without crashing', async () => {
    await p.appendEvent('s1', { kind: 'heartbeat', elapsedMs: 1 });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(root, 's1.jsonl'), 'not-json\n');
    await p.appendEvent('s1', { kind: 'heartbeat', elapsedMs: 2 });
    const events = await p.loadHistory('s1');
    expect(events).toHaveLength(2);
  });

  it('listSnapshots sorts by lastActivityAt descending', async () => {
    await p.saveSnapshot(makeSnap('a', { lastActivityAt: 10 }));
    await p.saveSnapshot(makeSnap('b', { lastActivityAt: 30 }));
    await p.saveSnapshot(makeSnap('c', { lastActivityAt: 20 }));
    const ids = (await p.listSnapshots()).map((s) => s.id);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('removeSession deletes both files and is idempotent', async () => {
    await p.saveSnapshot(makeSnap('s1'));
    await p.appendEvent('s1', { kind: 'heartbeat', elapsedMs: 0 });
    await p.removeSession('s1');
    expect(await p.loadSnapshot('s1')).toBeNull();
    expect(await p.loadHistory('s1')).toEqual([]);
    await p.removeSession('s1'); // must not throw
  });

  it('saveSnapshot tolerates concurrent writes to the same session id', async () => {
    // Five concurrent saves must all rename successfully (the hex-suffix tmp
    // path introduced in T2 avoids EEXIST / torn writes on the same .tmp file).
    const saves = Array.from({ length: 5 }, (_, i) =>
      p.saveSnapshot(makeSnap('sess-conc', { lastActivityAt: Date.now() + i })),
    );
    await Promise.all(saves);
    // Final state must be one of the 5 snapshots — just check it is readable.
    const loaded = await p.loadSnapshot('sess-conc');
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('sess-conc');
    // No leftover .tmp files in the root directory.
    const files = await readdir(root);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  describe('hasSnapshot', () => {
    it('returns true when snapshot file exists', async () => {
      await p.saveSnapshot(makeSnap('sess-abc-123'));
      expect(await p.hasSnapshot('sess-abc-123')).toBe(true);
    });

    it('returns false when not present', async () => {
      expect(await p.hasSnapshot('nonexistent-id')).toBe(false);
    });
  });
});
