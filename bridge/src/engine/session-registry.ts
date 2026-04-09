// bridge/src/engine/session-registry.ts
//
// Registry for active terminal sessions connected via IPC.
// Extracted from terminal-relay.ts to isolate session tracking.

import type { Socket } from 'node:net';

export interface SessionMeta {
  workdir: string;
  projectName: string;
}

export interface SessionEntry {
  socket: Socket;
  sessionId: string;
  workdir: string;
  projectName: string;
}

export class SessionRegistry {
  private sessions = new Map<string, SessionEntry>();

  register(sessionId: string, socket: Socket, meta: SessionMeta): void {
    this.sessions.set(sessionId, {
      socket,
      sessionId,
      workdir: meta.workdir,
      projectName: meta.projectName,
    });
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): SessionEntry[] {
    return [...this.sessions.values()];
  }

  getBySocket(socket: Socket): SessionEntry[] {
    return [...this.sessions.values()].filter(s => s.socket === socket);
  }

  removeBySocket(socket: Socket): string[] {
    const removed: string[] = [];
    for (const [sid, entry] of this.sessions) {
      if (entry.socket === socket) {
        this.sessions.delete(sid);
        removed.push(sid);
      }
    }
    return removed;
  }
}
