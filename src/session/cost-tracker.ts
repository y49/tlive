// src/session/cost-tracker.ts
import type { UsageStats } from '../runtime/events.js';

export class CostTracker {
  private state: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };

  add(u: UsageStats): void {
    this.state = {
      inputTokens: this.state.inputTokens + u.inputTokens,
      outputTokens: this.state.outputTokens + u.outputTokens,
      cacheReadTokens: (this.state.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
      cacheCreationTokens: (this.state.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0),
      costUsd: this.state.costUsd + u.costUsd,
    };
  }

  snapshot(): UsageStats { return { ...this.state }; }
}
