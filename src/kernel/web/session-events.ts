// src/kernel/web/session-events.ts
//
// Pure orchestration: map a vendor-neutral MonitorEvent onto the registry and
// produce the EventFrame to broadcast. No IM, no vendor field names.

import type { SessionRegistry } from './session-registry.js';
import type { EventFrame } from './event-hub.js';
import type { MonitorEvent } from '../hook/normalizer.js';

/** Remove sessions whose owning process died without unregistering (kill -9 /
 *  crash / terminal closed hard). Returns the remove-frames to broadcast.
 *
 *  Covers both kinds, because neither has another way out of that death:
 *  a wrapped session's `tlive run` never reaches session.unregister, and a
 *  hook session's agent never fires SessionEnd. A session with no pid (a
 *  vendor that exports none) is skipped — unsweepable is the safe side. */
export function sweepDeadSessions(
  sessions: SessionRegistry,
  isAlive: (pid: number) => boolean,
): EventFrame[] {
  const frames: EventFrame[] = [];
  for (const s of sessions.list()) {
    if (s.pid === undefined) continue;
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

/** @param key registry key this event belongs to — the wrapped session's uuid
 *  when the hook ran inside `tlive run` (TLIVE_SESSION), else the cwd.
 *  @param agentPid the agent process that ran this hook (CLAUDE_PID), recorded
 *  so sweepDeadSessions can reap the session if that process is killed without
 *  ever firing SessionEnd. Stamped on EVERY event, not just session-start: a
 *  daemon that restarts mid-session never sees that session's SessionStart, so
 *  whatever hook re-creates the entry has to carry the pid too. */
export function applyMonitorEvent(sessions: SessionRegistry, evt: MonitorEvent, key = evt.cwd, agentPid?: number): EventFrame {
  // Wrapped sessions keep the `tlive run` pid they registered with: that is the
  // process whose death means the pty is gone. Hooks fired inside the pty carry
  // TLIVE_SESSION and land on this same key, so without the guard the agent's
  // pid would overwrite it and the sweep would reap a live terminal as soon as
  // the agent exited.
  const pid = agentPid && sessions.get(key)?.kind !== 'wrapped' ? { pid: agentPid } : {};
  switch (evt.event) {
    case 'activity':
      return { type: 'session-upsert', session: sessions.upsert({ key, cwd: evt.cwd, status: 'active', ...pid }) };
    case 'attention': {
      // `lastMessage` carries whatever this session last SAID: the assistant's
      // real sentence from Stop, or a failure notification, which is the
      // dashboard's only view of a failed tool call — PostToolUse and
      // PostToolUseFailure are mutually exclusive, so a failure produces no
      // activity event to carry it.
      //
      // An EMPTY message means the notification had no content of its own, and
      // must not overwrite what the session actually said. Claude Code's
      // 60-second "waiting for your input" is exactly that: boilerplate about a
      // state the status already carries, and letting it through made the
      // dashboard quote it as if the assistant had said it, while the desktop —
      // fed by the Stop hook — showed the real sentence. Two surfaces, one
      // event, two different stories.
      const said = evt.lastMessage ?? evt.message;
      return { type: 'session-upsert', session: sessions.upsert({ key, cwd: evt.cwd, status: 'waiting-input', ...(said ? { lastMessage: said } : {}), ...pid }) };
    }
    case 'prompt':
      return { type: 'session-upsert', session: sessions.upsert({ key, cwd: evt.cwd, status: 'active', lastPrompt: evt.prompt, ...pid }) };
    case 'subagent': {
      // 计数型:prev + delta,clamp ≥0(SubagentStart/Stop 若不成对也不会变负)。
      const count = Math.max(0, (sessions.get(key)?.activeSubagents ?? 0) + evt.delta);
      return { type: 'session-upsert', session: sessions.upsert({ key, cwd: evt.cwd, status: 'active', activeSubagents: count, ...pid }) };
    }
    case 'permission-denied':
      // The user denied in the local terminal; the agent turn continues.
      // The pending-approval cancel happens in bootstrap — here just reflect activity.
      return { type: 'session-upsert', session: sessions.upsert({ key, cwd: evt.cwd, status: 'active', ...pid }) };
    case 'session-start':
      return { type: 'session-upsert', session: sessions.upsert({ key, cwd: evt.cwd, kind: 'hook', status: 'idle', ...pid }) };
    case 'session-end': {
      const existing = sessions.get(key);
      if (existing?.kind === 'wrapped') {
        // Claude Code fires SessionEnd(reason="clear") on /clear WITHOUT exiting the process
        // (immediately followed by SessionStart). Do NOT remove a live wrapped session —
        // downgrade it to idle and clear pending; session.unregister(uuid) removes it on exit.
        const session = sessions.upsert({ key, cwd: evt.cwd, status: 'idle', pending: null });
        return { type: 'session-upsert', session };
      }
      const removed = sessions.remove(key);
      return { type: 'session-remove', id: removed?.id ?? key };
    }
  }
}
