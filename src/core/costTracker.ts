// src/core/costTracker.ts
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-6':  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-6':    { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-4-5':   { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  default:              { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private model = 'default';

  setModel(model: string): void { this.model = model; }

  addUsage(usage: Record<string, unknown>): void {
    this.inputTokens += (usage.input_tokens as number) || 0;
    this.outputTokens += (usage.output_tokens as number) || 0;
    this.cacheReadTokens += (usage.cache_read_input_tokens as number) || 0;
    this.cacheWriteTokens += (usage.cache_creation_input_tokens as number) || 0;
  }

  get summary(): UsageSummary {
    const p = PRICING[this.model] ?? PRICING.default;
    const cost =
      (this.inputTokens / 1_000_000) * p.input +
      (this.outputTokens / 1_000_000) * p.output +
      (this.cacheReadTokens / 1_000_000) * p.cacheRead +
      (this.cacheWriteTokens / 1_000_000) * p.cacheWrite;
    return {
      inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens, cacheWriteTokens: this.cacheWriteTokens,
      estimatedCostUsd: Math.round(cost * 1000) / 1000,
    };
  }

  formatSummary(): string {
    const s = this.summary;
    const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    return `Tokens: ${fmt(s.inputTokens)} in / ${fmt(s.outputTokens)} out` +
      (s.cacheReadTokens ? ` / ${fmt(s.cacheReadTokens)} cached` : '') +
      `\nCost: ~$${s.estimatedCostUsd.toFixed(2)}`;
  }

  reset(): void {
    this.inputTokens = this.outputTokens = this.cacheReadTokens = this.cacheWriteTokens = 0;
  }
}
