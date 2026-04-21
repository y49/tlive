// src/session/persistence.ts

import { mkdir, writeFile, readFile, appendFile, readdir, unlink, stat, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { NotificationEvent, UsageStats } from '../runtime/events.js';
import type { SessionContextSnapshot } from './context.js';

export interface SessionSnapshot {
  id: string;
  ctx: SessionContextSnapshot;
  status: 'starting' | 'active' | 'idle' | 'stopped';
  createdAt: number;
  lastActivityAt: number;
  cost: UsageStats;
  /** IDs of permission requests that were pending at snapshot time. */
  pendingPermissionIds: string[];
}

export class SessionPersistence {
  constructor(private readonly rootDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  private historyPath(id: string): string { return join(this.rootDir, `${id}.jsonl`); }
  private metaPath(id: string): string { return join(this.rootDir, `${id}.meta.json`); }

  async appendEvent(sessionId: string, event: NotificationEvent): Promise<void> {
    await appendFile(this.historyPath(sessionId), JSON.stringify(event) + '\n', 'utf-8');
  }

  async saveSnapshot(snap: SessionSnapshot): Promise<void> {
    const tmp = this.metaPath(snap.id) + '.tmp';
    await writeFile(tmp, JSON.stringify(snap, null, 2), 'utf-8');
    // Atomic rename — avoids torn writes on daemon crash
    await rename(tmp, this.metaPath(snap.id));
  }

  async loadSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    try {
      const raw = await readFile(this.metaPath(sessionId), 'utf-8');
      return JSON.parse(raw) as SessionSnapshot;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async listSnapshots(): Promise<SessionSnapshot[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const ids = entries.filter((f) => f.endsWith('.meta.json')).map((f) => f.slice(0, -'.meta.json'.length));
    const snaps: SessionSnapshot[] = [];
    for (const id of ids) {
      const snap = await this.loadSnapshot(id);
      if (snap) snaps.push(snap);
    }
    return snaps.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async loadHistory(sessionId: string): Promise<NotificationEvent[]> {
    const path = this.historyPath(sessionId);
    try { await stat(path); } catch { return []; }
    const events: NotificationEvent[] = [];
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf-8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as NotificationEvent); }
      catch { /* skip malformed line */ }
    }
    return events;
  }

  async removeSession(sessionId: string): Promise<void> {
    for (const p of [this.historyPath(sessionId), this.metaPath(sessionId)]) {
      try { await unlink(p); } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
}
