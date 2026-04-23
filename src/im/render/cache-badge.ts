// src/im/render/cache-badge.ts
//
// Cache-warmth badge helper (spec §7.4 emoji table). Renders a short inline
// badge describing the prompt-cache state so the activity sticky and session
// header can show it without duplicating semantics.

export type CacheState = 'hot' | 'cold' | 'unknown';

export interface CacheBadgeInput {
  /** Unix-ms timestamp until which the cache is warm, or null when cold. */
  warmUntilMs?: number | null;
  /** Override "now" for deterministic tests. */
  nowMs?: number;
}

export interface CacheBadge {
  state: CacheState;
  emoji: '⚡️' | '❄️' | '·';
  label: string;
}

/**
 * Compute a cache badge from a CacheWarmth snapshot. Returns `unknown` when
 * we have no warmth signal at all — renderers can hide the badge in that
 * case.
 */
export function cacheBadge(input: CacheBadgeInput): CacheBadge {
  const now = input.nowMs ?? Date.now();
  const warmUntil = input.warmUntilMs;
  if (warmUntil === undefined || warmUntil === null) {
    return { state: 'unknown', emoji: '·', label: '' };
  }
  const remaining = warmUntil - now;
  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    return { state: 'hot', emoji: '⚡️', label: `hot (${seconds}s)` };
  }
  return { state: 'cold', emoji: '❄️', label: 'cold' };
}

/** Convenience: one-line string like "⚡️ hot (45s)" or "❄️ cold". */
export function formatCacheBadge(input: CacheBadgeInput): string {
  const b = cacheBadge(input);
  if (b.state === 'unknown') return '';
  return `${b.emoji} ${b.label}`;
}
