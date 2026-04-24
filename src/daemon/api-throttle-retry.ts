// src/daemon/api-throttle-retry.ts
//
// API-throttle retry glue (spec §13.5).
//
// Runtime emits `{ kind: 'api_throttle', retryAfterMs }` on 429/5xx. A
// LocalSession sets `status.phase = 'errored'` + `code = 'api_throttled'`
// when it observes that event. This helper listens on the SessionManager
// event stream and calls `retryWithBackoff` to attempt resuming the turn
// after the hinted delay.
//
// Exposed as a small `startApiThrottleRetry` hook so daemon bootstrap can
// install it; tests drive events directly against the same helper.

import type { SessionManager } from '../session/manager.js';
import type { LocalSession } from '../session/local-session.js';
import type { Logger } from '../util/logger.js';
import { retryWithBackoff } from '../util/retry.js';

export interface ApiThrottleRetryOptions {
  sessions: SessionManager;
  /** Max retries before we escalate to 'errored' fatal. Default 3. */
  maxAttempts?: number;
  /** Sleep fn — tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export interface ApiThrottleRetryHandle {
  stop(): void;
}

/**
 * Subscribe to the SessionManager's event stream; for each session, if a
 * runtime emits `api_throttle`, attempt a bounded exponential-backoff retry
 * that resolves once the session's subsequent runtime event confirms
 * recovery. The retry calls `sessionId.resumeIfNeeded()` via a tiny wrapper
 * on SessionManager.
 */
export function startApiThrottleRetry(opts: ApiThrottleRetryOptions): ApiThrottleRetryHandle {
  const activeRetries = new Set<string>();

  const unsubscribe = opts.sessions.subscribe((ev) => {
    if (ev.kind !== 'created' && ev.kind !== 'resumed') return;
    const session = ev.session as LocalSession;
    const offSessionEvents = session.onEvent?.((e) => {
      if (e.kind === 'api_throttle') {
        if (activeRetries.has(session.id)) return;
        activeRetries.add(session.id);
        opts.logger?.warn('api_throttle observed', { sdkSessionId: session.id, retryAfterMs: e.retryAfterMs });
        void driveRetry(session, e.retryAfterMs, opts)
          .catch((err) => opts.logger?.error('retry loop failed', { sdkSessionId: session.id, reason: (err as Error).message }))
          .finally(() => activeRetries.delete(session.id));
      }
    });
    if (!offSessionEvents) return;
    const stopListener = opts.sessions.subscribe((stopEv) => {
      if (stopEv.kind === 'stopped' && stopEv.sessionId === session.id) {
        try { offSessionEvents(); } catch { /* isolate */ }
        stopListener();
      }
    });
  });

  return { stop() { unsubscribe(); } };
}

async function driveRetry(
  session: LocalSession,
  initialRetryAfterMs: number,
  opts: ApiThrottleRetryOptions,
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));

  await sleep(Math.max(0, initialRetryAfterMs));

  await retryWithBackoff<void>(async (attempt) => {
    opts.logger?.info('retry attempt', { sdkSessionId: session.id, attempt: attempt + 1 });
    // The session stays registered; a runtime-level resume is the SDK's job.
    // We call `resumeLocal` via the manager to re-issue the last turn.
    const manager = getManagerFor(session);
    const resumed = await manager.resumeLocal(session.id);
    if (!resumed) throw new Error('resumeLocal returned null');
  }, {
    maxAttempts,
    sleep,
    onRetry: (err, attempt, next) => opts.logger?.warn('retry backoff', { sdkSessionId: session.id, attempt: attempt + 1, nextMs: next, reason: (err as Error).message }),
  }).catch((err) => {
    opts.logger?.error('api_throttle retries exhausted', { sdkSessionId: session.id, reason: (err as Error).message });
    // Propagate as a fatal status via the session's runtime_error channel
    // by forcing a session stop — the final state is recorded via meta.
    return opts.sessions.stop(session.id).catch(() => undefined);
  });
}

// LocalSession doesn't expose the manager ref; we rely on the bootstrap
// always being called with the single shared manager and closure-capture
// instead. For test ergonomics the getter is injectable; production uses
// the default. */
let managerOverride: SessionManager | null = null;
export function _setManagerOverrideForTests(m: SessionManager | null): void { managerOverride = m; }
function getManagerFor(session: LocalSession): SessionManager {
  if (managerOverride) return managerOverride;
  // fallback via session context; localSession keeps a ref to the factory-
  // provided manager only implicitly. We look it up from the registry via
  // the global scope — which in production is set during bootstrap.
  const anySess = session as unknown as { _manager?: SessionManager };
  if (anySess._manager) return anySess._manager;
  throw new Error('api_throttle retry: manager not available on session');
}

export function bindManagerForRetry(session: LocalSession, manager: SessionManager): void {
  (session as unknown as { _manager?: SessionManager })._manager = manager;
}
