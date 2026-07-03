// src/kernel/web/session-events.ts
//
// Pure orchestration: map a vendor-neutral MonitorEvent onto the registry and
// produce the EventFrame to broadcast. No IM, no vendor field names.

import type { SessionRegistry } from './session-registry.js';
import type { EventFrame } from './event-hub.js';
import type { MonitorEvent } from '../hook/normalizer.js';

/** Remove wrapped sessions whose `tlive run` process died without unregistering
 *  (kill -9 / crash). Returns the remove-frames to broadcast. */
export function sweepDeadSessions(
  sessions: SessionRegistry,
  isAlive: (pid: number) => boolean,
): EventFrame[] {
  const frames: EventFrame[] = [];
  for (const s of sessions.list()) {
    if (s.kind !== 'wrapped' || s.pid === undefined) continue;
    if (!isAlive(s.pid)) {
      sessions.remove(s.id);
      frames.push({ type: 'session-remove', id: s.id });
    }
  }
  return frames;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function applyMonitorEvent(sessions: SessionRegistry, evt: MonitorEvent): EventFrame {
  switch (evt.event) {
    case 'activity':
      return { type: 'session-upsert', session: sessions.upsert({ cwd: evt.cwd, status: 'active' }) };
    case 'attention':
      // lastMessage is reused for both Stop's last_assistant_message and Notification text —
      // a deliberate lightweight tradeoff; a distinct notificationText field is a later refinement.
      return { type: 'session-upsert', session: sessions.upsert({ cwd: evt.cwd, status: 'waiting-input', lastMessage: evt.lastMessage ?? evt.message }) };
    case 'prompt':
      return { type: 'session-upsert', session: sessions.upsert({ cwd: evt.cwd, status: 'active', lastPrompt: evt.prompt }) };
    case 'session-start':
      return { type: 'session-upsert', session: sessions.upsert({ cwd: evt.cwd, kind: 'hook', status: 'idle' }) };
    case 'session-end': {
      const existing = sessions.get(evt.cwd);
      if (existing?.kind === 'wrapped') {
        // Claude Code fires SessionEnd(reason="clear") on /clear WITHOUT exiting the process
        // (immediately followed by SessionStart). Do NOT remove a live wrapped session —
        // downgrade it to idle and clear pending; session.unregister(uuid) removes it on exit.
        const session = sessions.upsert({ cwd: evt.cwd, status: 'idle', pending: null });
        return { type: 'session-upsert', session };
      }
      const removed = sessions.remove(evt.cwd);
      return { type: 'session-remove', id: removed?.id ?? evt.cwd };
    }
  }
}
