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
 *
 * Returns:
 *   - 1_000_000 for known 1M-context Claude variants
 *   - 200_000 for known Claude 4.x family
 *   - 0 for UNKNOWN (e.g. non-Anthropic models like gpt-4o, deepseek-chat,
 *     local LLaMA, custom gateways). 0 is a "unknown" signal — the HUD
 *     renderer interprets it as "fall back to absolute token counts;
 *     don't fake a percentage against an arbitrary default".
 *
 * v3.2.2: changed unknown fallback from 200k to 0 to stop lying about
 * ratios when the user runs a model we can't recognize.
 */
export function modelMaxContextFor(modelId: string | null | undefined): number {
  if (!modelId) return 0;
  // 1M-context variants advertise via various suffixes:
  //   `-1m` (e.g. claude-sonnet-4-5-1m)
  //   `[1m]` (e.g. claude-opus-4-6[1m] — SDK exposes this style with anthropic-beta header)
  //   `(1m)` / `_1m` defensive
  if (/[-_\[(]1m(?:[-_\])]|$)/i.test(modelId)) return ONE_M;
  // All current Claude 4.x families (opus / sonnet / haiku) → 200k.
  if (/^claude-(opus|sonnet|haiku)-/i.test(modelId)) return TWO_HUNDRED_K;
  // Unknown — emit 0 as the "I don't know" signal. Renderer adapts.
  return 0;
}
