// src/daemon/stale-permission-recovery.ts
//
// Spec §13.4 — drives the CallbackRouter's stale-permission recovery flow.
//
// CallbackRouter already encapsulates the click-handling logic (attempt
// resume; edit stale card). This module adds the daemon-side behaviour
// that depends on more than just the broker/session state: after a successful
// resume, we wait ~2s for the SDK to re-emit the same permission request.
// If it re-emits, the `SessionFrontend` renders a fresh card; if it doesn't,
// the original card is edited to "session restored, awaiting new card".
//
// Exported as a helper the CallbackRouter's deps can call directly, so this
// module doesn't fork routing logic — it composes on top.

import type { SessionManager } from '../session/manager.js';
import type { PermissionBroker } from '../permission/broker.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { ChannelType } from '../workspace/bindings.js';
import type { Logger } from '../util/logger.js';

export interface StaleRecoveryDeps {
  sessions: SessionManager;
  permissionBroker: PermissionBroker;
  adapters: Partial<Record<ChannelType, PlatformAdapter>>;
  /** Time to wait for SDK re-emit. Default 2000ms. */
  waitMs?: number;
  logger?: Logger;
}

export interface StaleRecoveryResult {
  status: 'resumed_waiting' | 'resumed_re-emitted' | 'invalidated';
}

/**
 * Try to rescue a stale permission card. `messageId` + `channelType` +
 * `chatId` let us edit the old card in-place.
 *
 * Algorithm:
 * 1. Attempt `SessionManager.resumeLocal(sdkSessionId)`.
 * 2. If failed → edit old card to "invalidated", return `invalidated`.
 * 3. If resumed → wait up to `waitMs` for the broker to emit a new pending
 *    request for this session. If a new request arrives, `resumed_re-emitted`;
 *    else `resumed_waiting` with the card edited to "session restored".
 */
export async function recoverStalePermissionCard(
  sdkSessionId: string,
  messageId: string,
  chatId: string,
  channelType: ChannelType,
  deps: StaleRecoveryDeps,
): Promise<StaleRecoveryResult> {
  const waitMs = deps.waitMs ?? 2000;
  const adapter = deps.adapters[channelType];

  let resumed: Awaited<ReturnType<SessionManager['resumeLocal']>> = null;
  try { resumed = await deps.sessions.resumeLocal(sdkSessionId); }
  catch (err) { deps.logger?.warn('stale-recovery resume failed', { sdkSessionId, reason: (err as Error).message }); }

  if (!resumed) {
    await adapter?.edit(messageId, chatId, 'Session invalidated — this card is no longer actionable.').catch(() => undefined);
    return { status: 'invalidated' };
  }

  // Wait for a re-emit via the broker's pending list. The broker doesn't
  // expose a direct event subscribe API, so we poll pendingFor() briefly.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const pending = deps.permissionBroker.pendingFor(sdkSessionId);
    if (pending.length > 0) {
      // A new card will be rendered by SessionFrontend; mark old card as
      // superseded.
      await adapter?.edit(messageId, chatId, 'Session restored — a new permission card is above.').catch(() => undefined);
      return { status: 'resumed_re-emitted' };
    }
    await sleep(100);
  }

  // No re-emit; note it for the user but keep session live.
  await adapter?.edit(messageId, chatId, 'Session restored — awaiting new card from the agent.').catch(() => undefined);
  return { status: 'resumed_waiting' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}
