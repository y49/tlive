// src/session/persistence.ts
//
// Session metadata persistence. v1.0 semantics: meta-only (no jsonl history
// — the SDK's own jsonl in ~/.claude/projects/... is authoritative). Kept
// alongside the legacy jsonl-history API so the v0.x bridge continues to
// compile until T8 deletes it.
//
// - New code paths should use `writeMeta` / `loadMeta` / `loadAllMeta` which
//   key on sdkSessionId and live under ~/.tlive/sessions/<id>.meta.json.
// - Legacy `saveSnapshot` / `loadSnapshot` / `appendEvent` / `loadHistory` /
//   `listSnapshots` / `removeSession` keep the old SessionSnapshot shape and
//   jsonl history working for the bridge + existing unit tests.
//
// Atomic writes via write-to-tmp-then-rename guard against torn writes on
// daemon crash.

import { mkdir, writeFile, readFile, appendFile, readdir, unlink, stat, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AgentProvider, PermissionRequest, AskUserQuestionRequest, ElicitationRequest,
} from '../runtime/types.js';
import type { NotificationEvent, UsageStats } from '../runtime/events.js';
import type { SessionContextSnapshot } from './context.js';

// ---- New meta-only shape (spec §4.6) ---------------------------------------

export interface SessionMeta {
  sdkSessionId: string;
  provider: AgentProvider;
  workspaceId: string;
  workdir: string;
  title?: string;
  createdAt: string;       // ISO8601
  lastActivityAt: string;  // ISO8601
  status: 'running' | 'stopped' | 'archived';
  cost: { totalCost: number; inputTokens: number; outputTokens: number };
  pendingPermissions: Array<
    Pick<PermissionRequest, 'id' | 'category' | 'toolName' | 'toolInput'> & { createdAt: string }
  >;
  pendingAskQuestions: Array<
    Pick<AskUserQuestionRequest, 'id' | 'prompt' | 'options'> & { createdAt: string }
  >;
  pendingElicitations: Array<
    Pick<ElicitationRequest, 'id' | 'mcpServerName' | 'description'> & { createdAt: string }
  >;
  lastChatBinding?: { channelType: string; chatId: string };
}

// ---- Legacy snapshot shape (T1/T2) -----------------------------------------

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

  // ---- Path helpers ---------------------------------------------------------

  private historyPath(id: string): string { return join(this.rootDir, `${id}.jsonl`); }
  private metaPath(id: string): string { return join(this.rootDir, `${id}.meta.json`); }

  // ---- New meta-only API ----------------------------------------------------

  /** Atomic write of a SessionMeta record. */
  async writeMeta(meta: SessionMeta): Promise<void> {
    const tmp = this.metaPath(meta.sdkSessionId) + '.tmp';
    await writeFile(tmp, JSON.stringify(meta, null, 2), 'utf-8');
    await rename(tmp, this.metaPath(meta.sdkSessionId));
  }

  async loadMeta(sdkSessionId: string): Promise<SessionMeta | null> {
    try {
      const raw = await readFile(this.metaPath(sdkSessionId), 'utf-8');
      return JSON.parse(raw) as SessionMeta;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  /** Filesystem scan of all <id>.meta.json files. Skips corrupt entries. */
  async loadAllMeta(): Promise<SessionMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const results: SessionMeta[] = [];
    for (const name of entries) {
      if (!name.endsWith('.meta.json')) continue;
      try {
        const raw = await readFile(join(this.rootDir, name), 'utf-8');
        const parsed = JSON.parse(raw);
        // Only count records with the new shape (sdkSessionId field present),
        // so legacy SessionSnapshot files don't pollute loadAllMeta results.
        if (parsed && typeof parsed.sdkSessionId === 'string') {
          results.push(parsed as SessionMeta);
        }
      } catch { /* skip corrupt */ }
    }
    return results;
  }

  async deleteMeta(sdkSessionId: string): Promise<void> {
    await unlink(this.metaPath(sdkSessionId)).catch(() => undefined);
  }

  // ---- Legacy snapshot API (kept for bridge + v0 tests until T8) -----------

  async appendEvent(sessionId: string, event: NotificationEvent): Promise<void> {
    await appendFile(this.historyPath(sessionId), JSON.stringify(event) + '\n', 'utf-8');
  }

  async saveSnapshot(snap: SessionSnapshot): Promise<void> {
    const tmp = this.metaPath(snap.id) + '.tmp';
    await writeFile(tmp, JSON.stringify(snap, null, 2), 'utf-8');
    await rename(tmp, this.metaPath(snap.id));
  }

  async loadSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    try {
      const raw = await readFile(this.metaPath(sessionId), 'utf-8');
      const parsed = JSON.parse(raw);
      // Reject new-meta-shape records; they are not SessionSnapshot compatible.
      if (parsed && typeof parsed.id === 'string' && parsed.ctx) {
        return parsed as SessionSnapshot;
      }
      return null;
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
