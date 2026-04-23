// src/cost/tracker.ts
//
// Per-session cost accumulator. Consumed by LocalSession (folds usage from
// every `turn_end` event) and RemoteSession (MCP-synced deltas). Snapshot
// shape is the UsageStats contract; rollups.ts persists per-day aggregates
// keyed by workspace for the /cost dashboard.

import type { UsageStats } from '../runtime/events.js';

export class CostTracker {
  private state: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };

  /**
   * Fold a per-turn UsageStats delta into the running total. Optional cache
   * fields default to 0 so providers without cache metrics still compose.
   */
  add(u: UsageStats): void {
    this.state = {
      inputTokens: this.state.inputTokens + u.inputTokens,
      outputTokens: this.state.outputTokens + u.outputTokens,
      cacheReadTokens: (this.state.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
      cacheCreationTokens: (this.state.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0),
      costUsd: this.state.costUsd + u.costUsd,
    };
  }

  /**
   * Plan step 5 shape: accepts the turn_end-style delta where cache fields
   * are optional. Kept as a parallel entrypoint for the new LocalSession
   * path; internally funnels back through add().
   */
  record(delta: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    this.add({
      costUsd: delta.costUsd,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cacheReadTokens: delta.cacheReadTokens,
      cacheCreationTokens: delta.cacheCreationTokens,
    });
  }

  /** Cumulative total USD cost since construction. */
  get totalCost(): number { return this.state.costUsd; }
  get inputTokens(): number { return this.state.inputTokens; }
  get outputTokens(): number { return this.state.outputTokens; }
  get cacheReadTokens(): number { return this.state.cacheReadTokens ?? 0; }
  get cacheCreationTokens(): number { return this.state.cacheCreationTokens ?? 0; }

  snapshot(): UsageStats { return { ...this.state }; }
}
