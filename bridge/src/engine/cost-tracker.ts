export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  sessionTotalUsd?: number;
  queryCount?: number;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export class CostTracker {
  private startTime = 0;
  private sessionTotal = 0;
  private _queryCount = 0;

  start(): void {
    this.startTime = Date.now();
  }

  finish(usage: { input_tokens: number; output_tokens: number; cost_usd?: number }): UsageStats {
    const durationMs = Date.now() - this.startTime;
    const costUsd = usage.cost_usd ?? this.estimateCost(usage.input_tokens, usage.output_tokens);
    this._queryCount++;
    this.sessionTotal += costUsd;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costUsd,
      durationMs,
      sessionTotalUsd: this.sessionTotal,
      queryCount: this._queryCount,
    };
  }

  get queryCount(): number { return this._queryCount; }

  static format(stats: UsageStats): string {
    const duration = formatDuration(stats.durationMs);
    // When tokens are 0 (e.g. Codex SDK doesn't expose token counts), show only duration
    if (stats.inputTokens === 0 && stats.outputTokens === 0) {
      return `📊 ${duration}`;
    }
    const tokens = `${formatTokens(stats.inputTokens)}/${formatTokens(stats.outputTokens)} tok`;
    // Only show cost when non-zero (providers without cost_usd report 0)
    if (stats.costUsd > 0) {
      const cost = `$${stats.costUsd.toFixed(2)}`;
      if (stats.queryCount && stats.queryCount > 1 && stats.sessionTotalUsd != null) {
        return `📊 ${tokens} | ${cost} (Σ $${stats.sessionTotalUsd.toFixed(2)}) | ${duration}`;
      }
      return `📊 ${tokens} | ${cost} | ${duration}`;
    }
    return `📊 ${tokens} | ${duration}`;
  }

  private estimateCost(inputTokens: number, outputTokens: number): number {
    const inputRate = process.env.TL_COST_INPUT_PER_M ? parseFloat(process.env.TL_COST_INPUT_PER_M) : 3;
    const outputRate = process.env.TL_COST_OUTPUT_PER_M ? parseFloat(process.env.TL_COST_OUTPUT_PER_M) : 15;
    return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
  }
}
