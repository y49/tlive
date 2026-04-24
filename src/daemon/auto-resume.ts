// src/daemon/auto-resume.ts
//
// Auto-resume on startup (spec §13.2).
//
// For each Workspace, check its meta store:
//   - If meta.status === 'running' and lastActivityAt < `cutoffHours` old,
//     attempt `SessionManager.resumeLocal(sdkId)`.
//   - On failure (API error / jsonl corruption): mark `status: 'stopped'`
//     and push an IM notification via the supplied notifier.
// Non-active sessions are NOT auto-resumed; the user chooses via `/sessions`.

import type { SessionManager } from '../session/manager.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { SessionPersistence, SessionMeta } from '../session/persistence.js';
import type { Logger } from '../util/logger.js';

export interface AutoResumeDeps {
  sessions: SessionManager;
  workspaces: WorkspaceManager;
  persistence: SessionPersistence;
  /** Hours after which lastActivityAt disqualifies a session. Default: 24. */
  cutoffHours?: number;
  /** IM notifier for "couldn't auto-resume" messages. */
  notify?: (sessionId: string, text: string) => Promise<void> | void;
  logger?: Logger;
  /** Clock for tests. */
  now?: () => number;
}

export interface AutoResumeReport {
  attempted: number;
  resumed: string[];
  failed: Array<{ sdkSessionId: string; reason: string }>;
  skippedStale: string[];
}

export async function autoResumeOnStartup(deps: AutoResumeDeps): Promise<AutoResumeReport> {
  const cutoffHours = deps.cutoffHours ?? 24;
  const now = deps.now ?? Date.now;
  const cutoffMs = cutoffHours * 60 * 60 * 1000;
  const metas = await deps.persistence.loadAllMeta();
  const byId = new Map(metas.map((m) => [m.sdkSessionId, m]));

  const report: AutoResumeReport = { attempted: 0, resumed: [], failed: [], skippedStale: [] };

  for (const ws of deps.workspaces.list()) {
    const activeId = ws.activeSessionId;
    if (!activeId) continue;
    const meta = byId.get(activeId);
    if (!meta) { report.skippedStale.push(activeId); continue; }
    if (meta.status !== 'running') continue;

    const last = Date.parse(meta.lastActivityAt);
    if (!Number.isFinite(last) || now() - last > cutoffMs) {
      report.skippedStale.push(activeId);
      await markStopped(deps.persistence, meta);
      if (deps.notify) {
        try { await deps.notify(activeId, `session ${meta.title ?? meta.sdkSessionId.slice(0, 8)} idle > ${cutoffHours}h; not auto-resumed`); } catch { /* isolate */ }
      }
      deps.workspaces.clearActiveSession(ws.id);
      continue;
    }

    report.attempted += 1;
    try {
      const resumed = await deps.sessions.resumeLocal(activeId);
      if (resumed) {
        report.resumed.push(activeId);
        deps.logger?.info('auto-resume ok', { sdkSessionId: activeId, workspaceId: ws.id });
      } else {
        throw new Error('resumeLocal returned null');
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.failed.push({ sdkSessionId: activeId, reason });
      deps.logger?.warn('auto-resume failed', { sdkSessionId: activeId, reason });
      await markStopped(deps.persistence, meta).catch(() => undefined);
      if (deps.notify) {
        try { await deps.notify(activeId, `session ${meta.title ?? activeId.slice(0, 8)} couldn't auto-resume (${reason})`); } catch { /* isolate */ }
      }
      deps.workspaces.clearActiveSession(ws.id);
    }
  }

  return report;
}

async function markStopped(persistence: SessionPersistence, meta: SessionMeta): Promise<void> {
  await persistence.writeMeta({ ...meta, status: 'stopped', lastActivityAt: new Date().toISOString() });
}
