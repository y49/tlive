// tests/daemon/auto-resume.test.ts
//
// Verifies spec §5.4 — daemon startup is prune-only. No subprocesses are
// spawned for recent snapshots; resume happens lazily on first inbound.
//
// Cases:
//   - snapshot older than cutoff → deleted
//   - snapshot within cutoff → kept
//   - corrupt timestamp → pruned (treated as ancient)
//   - deleteMeta error → recorded as pruneErrors but doesn't crash
//   - empty store → no-op

import { describe, it, expect, vi } from 'vitest';
import { pruneStaleSnapshotsOnStartup } from '../../src/daemon/auto-resume.js';
import type { SessionPersistence, SessionMeta } from '../../src/session/persistence.js';

function mkMeta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    sdkSessionId: overrides.sdkSessionId ?? 'sid',
    provider: 'claude',
    workspaceId: 'ws1',
    workdir: '/x',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'running',
    cost: { totalCost: 0, inputTokens: 0, outputTokens: 0 },
    pendingPermissions: [],
    pendingAskQuestions: [],
    pendingElicitations: [],
    ...overrides,
  };
}

describe('pruneStaleSnapshotsOnStartup', () => {
  it('deletes snapshots older than cutoffHours', async () => {
    const now = Date.now();
    const stale = mkMeta({
      sdkSessionId: 'sid-stale',
      lastActivityAt: new Date(now - 200 * 60 * 60 * 1000).toISOString(), // 200h
    });
    const deleted: string[] = [];
    const persistence = {
      async loadAllMeta() { return [stale]; },
      async deleteMeta(id: string) { deleted.push(id); },
    } as unknown as SessionPersistence;

    const report = await pruneStaleSnapshotsOnStartup({
      persistence,
      cutoffHours: 168, // 1 week
      now: () => now,
    });

    expect(report.scanned).toBe(1);
    expect(report.pruned).toEqual(['sid-stale']);
    expect(report.pruneErrors).toEqual([]);
    expect(deleted).toEqual(['sid-stale']);
  });

  it('keeps snapshots within cutoffHours', async () => {
    const now = Date.now();
    const fresh = mkMeta({
      sdkSessionId: 'sid-fresh',
      lastActivityAt: new Date(now - 60 * 60 * 1000).toISOString(), // 1h ago
    });
    const deleted: string[] = [];
    const persistence = {
      async loadAllMeta() { return [fresh]; },
      async deleteMeta(id: string) { deleted.push(id); },
    } as unknown as SessionPersistence;

    const report = await pruneStaleSnapshotsOnStartup({
      persistence,
      cutoffHours: 168,
      now: () => now,
    });

    expect(report.scanned).toBe(1);
    expect(report.pruned).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('mixes fresh + stale correctly', async () => {
    const now = Date.now();
    const fresh = mkMeta({
      sdkSessionId: 'sid-fresh',
      lastActivityAt: new Date(now - 30 * 60 * 1000).toISOString(),
    });
    const stale = mkMeta({
      sdkSessionId: 'sid-stale',
      lastActivityAt: new Date(now - 200 * 60 * 60 * 1000).toISOString(),
    });
    const deleted: string[] = [];
    const persistence = {
      async loadAllMeta() { return [fresh, stale]; },
      async deleteMeta(id: string) { deleted.push(id); },
    } as unknown as SessionPersistence;

    const report = await pruneStaleSnapshotsOnStartup({
      persistence,
      cutoffHours: 168,
      now: () => now,
    });

    expect(report.scanned).toBe(2);
    expect(report.pruned).toEqual(['sid-stale']);
    expect(deleted).toEqual(['sid-stale']);
  });

  it('treats unparseable timestamps as ancient and prunes', async () => {
    const now = Date.now();
    const corrupt = mkMeta({
      sdkSessionId: 'sid-corrupt',
      lastActivityAt: 'not a date',
      createdAt: 'also not a date',
    });
    const deleted: string[] = [];
    const persistence = {
      async loadAllMeta() { return [corrupt]; },
      async deleteMeta(id: string) { deleted.push(id); },
    } as unknown as SessionPersistence;

    const report = await pruneStaleSnapshotsOnStartup({
      persistence,
      cutoffHours: 168,
      now: () => now,
    });

    expect(report.pruned).toEqual(['sid-corrupt']);
    expect(deleted).toEqual(['sid-corrupt']);
  });

  it('records pruneErrors when deleteMeta throws but does not crash', async () => {
    const now = Date.now();
    const stale = mkMeta({
      sdkSessionId: 'sid-doom',
      lastActivityAt: new Date(now - 200 * 60 * 60 * 1000).toISOString(),
    });
    const persistence = {
      async loadAllMeta() { return [stale]; },
      async deleteMeta() { throw new Error('disk full'); },
    } as unknown as SessionPersistence;

    const warn = vi.fn();
    const logger = {
      level: 'info' as const,
      debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => logger,
    };

    const report = await pruneStaleSnapshotsOnStartup({
      persistence,
      cutoffHours: 168,
      now: () => now,
      logger,
    });

    expect(report.pruned).toEqual([]);
    expect(report.pruneErrors).toHaveLength(1);
    expect(report.pruneErrors[0]!.sdkSessionId).toBe('sid-doom');
    expect(report.pruneErrors[0]!.reason).toContain('disk full');
    expect(warn).toHaveBeenCalled();
  });

  it('returns empty report when no metas exist', async () => {
    const persistence = {
      async loadAllMeta() { return []; },
      async deleteMeta() { /* unused */ },
    } as unknown as SessionPersistence;
    const report = await pruneStaleSnapshotsOnStartup({
      persistence,
      cutoffHours: 168,
    });
    expect(report.scanned).toBe(0);
    expect(report.pruned).toEqual([]);
    expect(report.pruneErrors).toEqual([]);
  });

  it('does NOT spawn subprocesses (no SessionManager / WorkspaceManager refs)', async () => {
    // Sanity: the function signature should not require sessions/workspaces.
    // If you accidentally re-add them, this test will fail at compile time.
    const persistence = {
      async loadAllMeta() { return []; },
      async deleteMeta() { /* noop */ },
    } as unknown as SessionPersistence;
    const report = await pruneStaleSnapshotsOnStartup({ persistence, cutoffHours: 168 });
    expect(report).toEqual({ scanned: 0, pruned: [], pruneErrors: [] });
  });
});
