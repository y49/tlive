// src/daemon/auto-resume.ts
//
// Per spec §5.4 — daemon startup no longer spawns subprocesses for recent
// snapshots. Old behavior (`autoResumeOnStartup`) spun up SDK Query iterators
// for every "running" workspace, which made boot slow and held memory open
// for sessions the user might never touch again.
//
// New behavior: just prune snapshot files older than `cutoffHours`. Actual
// resume happens lazily on first inbound via WorkspaceManager.lazyResumeOrCreate
// + persistence.hasSnapshot (Task 9 + 10). The same lazy path now serves all
// three resume triggers (daemon restart / IdleStop / workspace switch).

import type { SessionPersistence } from '../session/persistence.js';
import type { Logger } from '../util/logger.js';

export interface PruneStaleSnapshotsOpts {
  persistence: SessionPersistence;
  /** Snapshots with lastActivityAt older than this are deleted. */
  cutoffHours: number;
  logger?: Logger;
  /** Clock for tests. */
  now?: () => number;
}

export interface PruneReport {
  scanned: number;
  pruned: string[];
  pruneErrors: Array<{ sdkSessionId: string; reason: string }>;
}

export async function pruneStaleSnapshotsOnStartup(
  opts: PruneStaleSnapshotsOpts,
): Promise<PruneReport> {
  const { persistence, cutoffHours, logger } = opts;
  const now = opts.now ?? Date.now;
  const cutoffMs = cutoffHours * 60 * 60 * 1000;

  const report: PruneReport = { scanned: 0, pruned: [], pruneErrors: [] };

  const metas = await persistence.loadAllMeta();
  for (const meta of metas) {
    report.scanned += 1;
    const lastIso = meta.lastActivityAt ?? meta.createdAt;
    const last = Date.parse(lastIso);
    // If timestamp is unparseable, treat as ancient and prune so corrupt
    // entries don't accumulate forever.
    const ageMs = Number.isFinite(last) ? now() - last : Infinity;
    if (ageMs <= cutoffMs) continue;

    try {
      await persistence.deleteMeta(meta.sdkSessionId);
      report.pruned.push(meta.sdkSessionId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.pruneErrors.push({ sdkSessionId: meta.sdkSessionId, reason });
      logger?.warn('snapshot prune failed', {
        sdkSessionId: meta.sdkSessionId,
        reason,
      });
    }
  }

  logger?.info('snapshot prune complete', {
    scanned: report.scanned,
    pruned: report.pruned.length,
    pruneErrors: report.pruneErrors.length,
    cutoffHours,
  });

  return report;
}
