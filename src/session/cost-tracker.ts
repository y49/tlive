// src/session/cost-tracker.ts
import type { UsageStats } from '../runtime/events.js';

export class CostTracker {
  private state: UsageStats = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };

  add(u: UsageStats): void {
    this.state = {
      inputTokens: this.state.inputTokens + u.inputTokens,
      outputTokens: this.state.outputTokens + u.outputTokens,
      costUsd: this.state.costUsd + u.costUsd,
      durationMs: this.state.durationMs + u.durationMs,
    };
  }

  snapshot(): UsageStats { return { ...this.state }; }
}
