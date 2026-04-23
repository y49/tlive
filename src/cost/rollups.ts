// src/cost/rollups.ts
//
// Per-day cost rollup store. Every `turn_end` append-writes a delta line to
// `~/.tlive/cost-rollups.jsonl`; the `/cost` dashboard aggregates the file
// into per-workspace, per-day, and per-month summaries. Plain jsonl makes it
// trivially replayable without a database dependency.

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface RollupDelta {
  workspaceId: string;
  sdkSessionId: string;
  /** `YYYY-MM-DD` — single stable key for daily aggregation. */
  dateKey: string;
  deltaUsd: number;
  deltaIn: number;
  deltaOut: number;
  /** Epoch ms — preserved so UI can sort/display finer granularity. */
  at: number;
}

export interface DailyRollup {
  dateKey: string;
  workspaceId: string;
  totalUsd: number;
  totalIn: number;
  totalOut: number;
  sessionIds: Set<string>;
}

export function dateKeyOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export class CostRollupStore {
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? join(homedir(), '.tlive', 'cost-rollups.jsonl');
  }

  async append(delta: RollupDelta): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    await fs.appendFile(this.path, JSON.stringify(delta) + '\n', 'utf8');
  }

  async load(): Promise<RollupDelta[]> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const out: RollupDelta[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed) as RollupDelta); }
        catch { /* skip malformed line, don't fail the whole load */ }
      }
      return out;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Test/reset helper. Idempotent; missing file is fine. */
  async reset(): Promise<void> {
    await fs.unlink(this.path).catch(() => undefined);
  }
}

/**
 * Fold a stream of RollupDelta entries into per-(dateKey, workspaceId)
 * buckets. Stable output sort: dateKey desc then workspaceId asc.
 */
export function aggregateDaily(deltas: readonly RollupDelta[]): DailyRollup[] {
  const buckets = new Map<string, DailyRollup>();
  for (const d of deltas) {
    const key = `${d.dateKey}::${d.workspaceId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        dateKey: d.dateKey,
        workspaceId: d.workspaceId,
        totalUsd: 0,
        totalIn: 0,
        totalOut: 0,
        sessionIds: new Set(),
      };
      buckets.set(key, bucket);
    }
    bucket.totalUsd += d.deltaUsd;
    bucket.totalIn += d.deltaIn;
    bucket.totalOut += d.deltaOut;
    bucket.sessionIds.add(d.sdkSessionId);
  }
  return [...buckets.values()].sort((a, b) => {
    if (a.dateKey !== b.dateKey) return b.dateKey.localeCompare(a.dateKey);
    return a.workspaceId.localeCompare(b.workspaceId);
  });
}
