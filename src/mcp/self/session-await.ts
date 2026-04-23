// src/mcp/self/session-await.ts
//
// Helper for `tlive.sessions.execute` + orchestrator: subscribe to a
// LocalSession's event stream, sendInput, then accumulate assistant output
// between `turn_start` and `turn_end` (mode: 'complete') or return on the
// first `assistant_text` (mode: 'first_response').
//
// Timeout returns whatever partial text has been captured so far plus
// { ok: false, reason: 'timeout' }. The inner sendInput failure surfaces
// as a rejected promise so callers get real errors, not mute timeouts.

import type { LocalSession } from '../../session/local-session.js';
import type { NotificationEvent } from '../../runtime/events.js';

export interface AwaitTurnOutput {
  ok: boolean;
  output: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  reason?: 'timeout';
}

export type WaitMode = 'complete' | 'first_response';

/** Default ceiling for a single long-running turn. */
export const DEFAULT_AWAIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Subscribe to `session.onEvent`, send `prompt`, accumulate assistant text
 * between turn_start and turn_end (mode === 'complete') or resolve on the
 * first `assistant_text` (mode === 'first_response').
 */
export async function awaitTurnOutput(
  session: LocalSession,
  prompt: string,
  mode: WaitMode,
  timeoutMs = DEFAULT_AWAIT_TIMEOUT_MS,
): Promise<AwaitTurnOutput> {
  let captured = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let activeTurnId: string | null = null;

  return new Promise<AwaitTurnOutput>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { unsub(); } catch { /* isolate */ }
      resolve({ ok: false, output: captured, reason: 'timeout' });
    }, Math.max(1, timeoutMs));

    const unsub = session.onEvent((e: NotificationEvent) => {
      if (settled) return;
      switch (e.kind) {
        case 'turn_start':
          // Lock onto the first turn we see after sendInput. Subsequent
          // turns (e.g. subagent-spawn loop) are ignored for 'complete'.
          if (!activeTurnId) activeTurnId = e.turnId;
          break;
        case 'assistant_text':
          // `turnId` may not yet match if the runtime emits assistant_text
          // before turn_start; be lenient — any assistant_text before
          // turn_end counts.
          captured += e.text;
          if (mode === 'first_response') {
            settled = true;
            clearTimeout(timer);
            try { unsub(); } catch { /* isolate */ }
            resolve({ ok: true, output: captured });
          }
          break;
        case 'turn_end':
          if (mode !== 'complete') break;
          if (activeTurnId && e.turnId !== activeTurnId) break;
          tokensIn = e.tokensIn;
          tokensOut = e.tokensOut;
          costUsd = e.costUsd;
          settled = true;
          clearTimeout(timer);
          try { unsub(); } catch { /* isolate */ }
          resolve({ ok: true, output: captured, tokensIn, tokensOut, costUsd });
          break;
        case 'session_complete':
          // Session ended before turn_end — surface whatever we have.
          settled = true;
          clearTimeout(timer);
          try { unsub(); } catch { /* isolate */ }
          resolve({ ok: true, output: captured });
          break;
        case 'runtime_error':
          if (e.severity === 'fatal') {
            settled = true;
            clearTimeout(timer);
            try { unsub(); } catch { /* isolate */ }
            resolve({ ok: false, output: captured, reason: 'timeout' });
          }
          break;
        default:
          // Ignore all other events.
          break;
      }
    });

    // Kick off the turn. A sendInput rejection is surfaced to the caller
    // so orchestrator error policies see a real reason.
    session.sendInput(prompt, 'im').catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unsub(); } catch { /* isolate */ }
      reject(err);
    });
  });
}
