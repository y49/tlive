// src/runtime/claude/model-context.ts
//
// Map a Claude model id to its max context window in tokens.
// Mirrors what Claude Code does internally to populate
// `context_window.context_window_size` in its statusline JSON
// (per https://code.claude.com/docs/en/statusline — "200000 by default,
// or 1000000 for models with extended context").
//
// Anthropic does not expose the context window via SDK init frames; the
// /v1/models REST endpoint does (max_input_tokens) but we avoid the network
// dependency at session startup. A 5-line lookup matches their own approach
// in Claude Code itself.
//
// When Anthropic ships a new family or a 1M variant, append a row.

const TWO_HUNDRED_K = 200_000;
const ONE_M = 1_000_000;

/**
 * Resolve max context tokens for a model id.
 * Falls back to 200_000 for unrecognized ids — current Claude 4.x family
 * is uniformly 200k; any new family that diverges should be added here.
 */
export function modelMaxContextFor(modelId: string | null | undefined): number {
  if (!modelId) return TWO_HUNDRED_K;
  // 1M-context variants advertise the suffix `-1m` (e.g. claude-sonnet-4-5-1m).
  if (/-1m\b/i.test(modelId) || /-1m-/i.test(modelId)) return ONE_M;
  // All current Claude 4.x families (opus / sonnet / haiku) → 200k.
  if (/^claude-(opus|sonnet|haiku)-/i.test(modelId)) return TWO_HUNDRED_K;
  return TWO_HUNDRED_K;
}
