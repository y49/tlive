// src/daemon/idle-stop.ts
//
// Idle auto-stop per session (spec §13.3).
//
// When a session receives no inbound IM message (or internal activity) for
// longer than `idleHours`, we fire `SessionManager.stop(id)`, mark the meta
// `status: 'stopped'`, and optionally notify IM.
//
// Implementation: one shared interval timer walks the registered session map
// every `tickMs`, computes `now - lastActivityAt`, and stops eligible
// sessions. A per-session opt-out is supported via `skipIds` in case a
// caller wants to exempt a session temporarily.

import type { SessionManager } from '../session/manager.js';
import type { SessionPersistence, SessionMeta } from '../session/persistence.js';
import type { SessionInfo } from '../session/types.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { Logger } from '../util/logger.js';

export interface IdleStopOptions {
  sessions: SessionManager;
  persistence: SessionPersistence;
  /**
   * Optional WorkspaceManager — when provided, IdleStop also clears the
   * chat binding's `activeSessionId` after stopping the session, so the
   * binding state matches reality (spec §7). Without this, the binding
   * keeps pointing at a stopped sdkSessionId.
   */
  workspaces?: WorkspaceManager;
  /** Idle threshold hours; default 24. */
  idleHours?: number;
  /** Tick interval ms; default 5 minutes. Set smaller in tests. */
  tickMs?: number;
  /** Optional IM notifier called with (sessionId, text) post-stop. */
  notify?: (sessionId: string, text: string) => Promise<void> | void;
  /** Clock function — tests inject a fake. */
  now?: () => number;
  logger?: Logger;
}

export interface IdleStopHandle {
  /** Stop the tick timer. Idempotent. */
  stop(): void;
  /** Temporarily skip a given session id for the next tick only. */
  skip(id: string): void;
  /** Force a single tick — exposed for tests. */
  tickOnce(): Promise<string[]>;
}

export function startIdleStop(opts: IdleStopOptions): IdleStopHandle {
  const idleHours = opts.idleHours ?? 24;
  const tickMs = opts.tickMs ?? 5 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const skipOnce = new Set<string>();
  const idleMs = idleHours * 60 * 60 * 1000;

  async function tickOnce(): Promise<string[]> {
    const stopped: string[] = [];
    const snapshots: SessionInfo[] = opts.sessions.listInfo('local');
    for (const info of snapshots) {
      if (skipOnce.has(info.id)) { skipOnce.delete(info.id); continue; }
      const lastMs = info.lastActivityAt;
      if (!Number.isFinite(lastMs)) continue;
      if (now() - lastMs <= idleMs) continue;

      try {
        await opts.sessions.stop(info.id);
        stopped.push(info.id);
        opts.logger?.info('idle stop', { sdkSessionId: info.id, idleHours });
        // Spec §7 — clear the binding's activeSessionId so it stops pointing
        // at a stopped session. Skip if the session has no ownerChat (remote)
        // or the WorkspaceManager wasn't injected (tests / partial wiring).
        if (opts.workspaces && info.ownerChat) {
          try {
            opts.workspaces.clearActiveSessionForChat(info.ownerChat.channelType, info.ownerChat.chatId);
          } catch (err) {
            opts.logger?.warn('idle stop clear-binding failed', {
              sdkSessionId: info.id,
              channelType: info.ownerChat.channelType,
              chatId: info.ownerChat.chatId,
              reason: (err as Error).message,
            });
          }
        }
        const meta = await opts.persistence.loadMeta(info.id);
        if (meta) {
          const updated: SessionMeta = { ...meta, status: 'stopped', lastActivityAt: new Date().toISOString() };
          await opts.persistence.writeMeta(updated).catch(() => undefined);
        }
        if (opts.notify) {
          try { await opts.notify(info.id, `session ${info.id.slice(0, 8)} idle-stopped after ${idleHours}h`); }
          catch { /* isolate */ }
        }
      } catch (err) {
        opts.logger?.warn('idle stop failed', { sdkSessionId: info.id, reason: (err as Error).message });
      }
    }
    return stopped;
  }

  const timer = setInterval(() => {
    tickOnce().catch((err) => opts.logger?.error('idle-stop tick failed', { reason: (err as Error).message }));
  }, tickMs);
  timer.unref?.();

  return {
    stop() { clearInterval(timer); },
    skip(id) { skipOnce.add(id); },
    tickOnce,
  };
}
