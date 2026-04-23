// src/cost/dashboard.ts
//
// Pure aggregation helpers over CostRollupStore deltas — power the `/cost`
// IM command. No I/O here; the caller loads RollupDelta[] once and feeds
// this module. Keeps renderers testable without touching disk.

import type { RollupDelta, DailyRollup } from './rollups.js';
import { aggregateDaily } from './rollups.js';

export interface WorkspaceTotals {
  workspaceId: string;
  totalUsd: number;
  totalIn: number;
  totalOut: number;
  /** Number of unique sessions contributing to this workspace's total. */
  sessions: number;
}

export interface DashboardSummary {
  /** Grand total across every delta. */
  grandTotalUsd: number;
  /** Totals per workspace, sorted by cost desc. */
  workspaces: WorkspaceTotals[];
  /** Daily buckets for charting / recent activity. */
  daily: DailyRollup[];
}

/**
 * Build a dashboard summary. Optional filters narrow the view — pass
 * `{ workspaceId }` for a single workspace, `{ sinceMs }` for "last 7 days".
 */
export function buildDashboard(
  deltas: readonly RollupDelta[],
  filter: { workspaceId?: string; sinceMs?: number } = {},
): DashboardSummary {
  const filtered = deltas.filter((d) => {
    if (filter.workspaceId && d.workspaceId !== filter.workspaceId) return false;
    if (filter.sinceMs !== undefined && d.at < filter.sinceMs) return false;
    return true;
  });

  const daily = aggregateDaily(filtered);

  const byWorkspace = new Map<string, WorkspaceTotals>();
  for (const d of filtered) {
    let w = byWorkspace.get(d.workspaceId);
    if (!w) {
      w = {
        workspaceId: d.workspaceId,
        totalUsd: 0,
        totalIn: 0,
        totalOut: 0,
        sessions: 0,
      };
      byWorkspace.set(d.workspaceId, w);
    }
    w.totalUsd += d.deltaUsd;
    w.totalIn += d.deltaIn;
    w.totalOut += d.deltaOut;
  }
  // Second pass to count unique sessions per workspace
  const sessionSets = new Map<string, Set<string>>();
  for (const d of filtered) {
    let set = sessionSets.get(d.workspaceId);
    if (!set) { set = new Set(); sessionSets.set(d.workspaceId, set); }
    set.add(d.sdkSessionId);
  }
  for (const [wsId, set] of sessionSets) {
    const w = byWorkspace.get(wsId);
    if (w) w.sessions = set.size;
  }

  const workspaces = [...byWorkspace.values()].sort((a, b) => b.totalUsd - a.totalUsd);
  const grandTotalUsd = workspaces.reduce((sum, w) => sum + w.totalUsd, 0);

  return { grandTotalUsd, workspaces, daily };
}
