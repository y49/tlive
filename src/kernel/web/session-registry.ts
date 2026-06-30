//
// In-memory registry of wrapped terminal sessions (created by `tlive run`,
// reported over IPC session.*). Hook-only sessions / activity / status badges
// are added in a later milestone.

import type { SessionMeta } from '../ipc/protocol.js';

export class SessionRegistry {
  private sessions = new Map<string, SessionMeta>();

  register(s: SessionMeta): void {
    this.sessions.set(s.id, s);
  }
  unregister(id: string): void {
    this.sessions.delete(id);
  }
  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }
  list(): SessionMeta[] {
    return [...this.sessions.values()];
  }
}
