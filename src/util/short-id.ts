// src/util/short-id.ts
//
// Short-alias helpers for SDK session IDs. Agent SDK/Codex session IDs are
// UUIDs (~36 chars with dashes) which is too long for IM chat commands. We
// display the first 8 hex chars after stripping dashes (~4 billion namespace
// per workspace) and resolve user-typed prefixes back to full ids with
// ambiguity detection.

/** Strip dashes and take first 8 hex chars. Stable across the full lifetime. */
export function shortId(sdkSessionId: string): string {
  return sdkSessionId.replace(/-/g, '').slice(0, 8);
}

/**
 * Resolve a user-typed prefix against a candidate set. Matches either the
 * short alias or the raw sdkSessionId (users can paste the full id).
 *
 * - Prefix shorter than 4 chars → always unresolved (collision risk too high).
 * - Exactly one match → resolved.
 * - Zero matches → unresolved (ambiguous empty).
 * - ≥2 matches → unresolved with `ambiguous` populated so the caller can
 *   render a disambiguation prompt.
 */
export function resolveByPrefix<T>(
  candidates: readonly T[],
  prefix: string,
  getId: (t: T) => string,
): { resolved: T | null; ambiguous: T[] } {
  if (prefix.length < 4) return { resolved: null, ambiguous: [] };
  const lowered = prefix.toLowerCase();
  const matches = candidates.filter((c) => {
    const id = getId(c);
    return shortId(id).startsWith(lowered) || id.toLowerCase().startsWith(lowered);
  });
  if (matches.length === 1) return { resolved: matches[0], ambiguous: [] };
  if (matches.length === 0) return { resolved: null, ambiguous: [] };
  return { resolved: null, ambiguous: [...matches] };
}
