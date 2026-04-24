// src/util/retry.ts
//
// Exponential-backoff retry with Retry-After awareness (spec §13.5).
//
// `retryWithBackoff(fn, opts)` retries `fn` up to `opts.maxAttempts` times
// when it rejects. Between attempts it sleeps `base * 2^attempt` ms (capped
// at `maxDelayMs`), unless the rejected error exposes a Retry-After hint
// (via `retryAfterMs`, `retryAfterSec`, `headers['retry-after']`, or
// `response.headers.get('retry-after')`), in which case that hint wins.
//
// Errors thrown by `fn` that are classified as non-retryable (via
// `isRetryable?`) short-circuit and propagate immediately. Default is
// "retry everything" to match spec §13.5 which defers classification to the
// runtime layer (runtime emits `api_throttle` only on 429/5xx).

export interface RetryWithBackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to abort retrying on this error. */
  isRetryable?: (err: unknown, attempt: number) => boolean;
  /** Sleep function — tests pass a fake timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Called with (err, attempt, nextDelayMs) before each wait; observers only. */
  onRetry?: (err: unknown, attempt: number, nextDelayMs: number) => void;
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryWithBackoffOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const isRetryable = opts.isRetryable ?? (() => true);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) break;
      if (!isRetryable(err, attempt)) break;
      const hint = parseRetryAfterMs(err);
      const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay = hint ?? exp;
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Extract a Retry-After hint in ms from a variety of error shapes:
 * - `err.retryAfterMs` (number)
 * - `err.retryAfterSec` (number)
 * - `err.headers['retry-after']` (string seconds or HTTP-date)
 * - `err.response.headers.get('retry-after')` (same)
 *
 * Returns null when no hint is parseable.
 */
export function parseRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;

  if (typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0) {
    return e.retryAfterMs;
  }
  if (typeof e.retryAfterSec === 'number' && Number.isFinite(e.retryAfterSec) && e.retryAfterSec >= 0) {
    return e.retryAfterSec * 1000;
  }

  // Plain-headers bag: err.headers['retry-after']
  const headers = e.headers;
  const fromHeaders = readRetryAfterHeader(headers);
  if (fromHeaders !== null) return fromHeaders;

  // Fetch-style: err.response.headers.get('retry-after')
  const response = e.response as { headers?: unknown } | undefined;
  if (response && response.headers) {
    const hget = (response.headers as { get?: (k: string) => string | null }).get;
    if (typeof hget === 'function') {
      const raw = hget.call(response.headers, 'retry-after') ?? hget.call(response.headers, 'Retry-After');
      const parsed = parseRetryAfterValue(raw);
      if (parsed !== null) return parsed;
    }
    const fromObj = readRetryAfterHeader(response.headers);
    if (fromObj !== null) return fromObj;
  }

  return null;
}

function readRetryAfterHeader(headers: unknown): number | null {
  if (!headers || typeof headers !== 'object') return null;
  const h = headers as Record<string, unknown>;
  const raw = (h['retry-after'] ?? h['Retry-After']) as unknown;
  return parseRetryAfterValue(raw);
}

function parseRetryAfterValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  // Seconds
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  if (/^\d+\.\d+$/.test(s)) return Math.round(Number(s) * 1000);
  // HTTP-date
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return Math.max(0, ms - Date.now());
  return null;
}
