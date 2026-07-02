//
// In-memory rich registry of AI-coding sessions, keyed/merged by cwd (id = cwd).
// Unifies wrapped sessions (`tlive run`, has a pty sockPath) and hook-only
// sessions (no pty, upserted from hook events). Vendor-neutral: no CC/Codex
// field names appear here. Stores only current state per session — never
// history/timelines. Staleness ("stuck Nm") is computed by the frontend from
// lastActivityAt; this layer only stores the timestamp.

import { basename } from 'node:path';
import type { SessionMeta } from '../ipc/protocol.js';

export type SessionStatus = 'active' | 'waiting-approval' | 'waiting-input' | 'idle';
export type SessionKind = 'wrapped' | 'hook';

export interface PendingApproval {
  requestId: string;
  title: string;
  body: string;
}

export interface SessionView {
  id: string; // = cwd
  label: string;
  cwd: string;
  kind: SessionKind;
  status: SessionStatus;
  lastActivityAt: number;
  lastMessage?: string;
  lastPrompt?: string;
  pending?: PendingApproval;
  /** Live Stop-hook continue requestId while status is waiting-input (reply target). */
  continueId?: string;
  muted: boolean;
  sockPath?: string; // wrapped sessions only
}

export interface UpsertPatch {
  cwd: string;
  label?: string;
  kind?: SessionKind;
  status?: SessionStatus;
  lastActivityAt?: number;
  lastMessage?: string;
  lastPrompt?: string;
  /** object → set; null → clear; undefined → leave unchanged. */
  pending?: PendingApproval | null;
  /** string → set; null → clear; undefined → leave unchanged. */
  continueId?: string | null;
  sockPath?: string;
}

export class SessionRegistry {
  private byCwd = new Map<string, SessionView>();
  private metaIdToCwd = new Map<string, string>();

  /** Merge a patch into the session keyed by cwd; create it if absent. */
  upsert(patch: UpsertPatch): SessionView {
    const prev = this.byCwd.get(patch.cwd);
    const next: SessionView = {
      id: patch.cwd,
      cwd: patch.cwd,
      label: patch.label ?? prev?.label ?? (basename(patch.cwd) || patch.cwd),
      kind: prev?.kind === 'wrapped' ? 'wrapped' : (patch.kind ?? prev?.kind ?? 'hook'),
      status: patch.status ?? prev?.status ?? 'idle',
      lastActivityAt: patch.lastActivityAt ?? Date.now(),
      muted: prev?.muted ?? false,
    };
    const lastMessage = patch.lastMessage ?? prev?.lastMessage;
    if (lastMessage !== undefined) next.lastMessage = lastMessage;
    const lastPrompt = patch.lastPrompt ?? prev?.lastPrompt;
    if (lastPrompt !== undefined) next.lastPrompt = lastPrompt;
    const sockPath = patch.sockPath ?? prev?.sockPath;
    if (sockPath !== undefined) next.sockPath = sockPath;
    if (patch.pending === null) {
      // cleared: leave next.pending undefined
    } else if (patch.pending !== undefined) {
      next.pending = patch.pending;
    } else if (prev?.pending !== undefined) {
      next.pending = prev.pending;
    }
    if (patch.continueId === null) {
      // cleared: leave next.continueId undefined
    } else if (patch.continueId !== undefined) {
      next.continueId = patch.continueId;
    } else if (prev?.continueId !== undefined) {
      next.continueId = prev.continueId;
    }
    this.byCwd.set(patch.cwd, next);
    return next;
  }

  /** Toggle per-session mute; returns the updated view, or undefined if absent. */
  setMuted(id: string, muted: boolean): SessionView | undefined {
    const prev = this.byCwd.get(id);
    if (!prev) return undefined;
    const next = { ...prev, muted };
    this.byCwd.set(id, next);
    return next;
  }

  /** Remove by id (= cwd). Returns the removed view for broadcast, or undefined. */
  remove(id: string): SessionView | undefined {
    const v = this.byCwd.get(id);
    if (!v) return undefined;
    this.byCwd.delete(id);
    for (const [mid, cwd] of this.metaIdToCwd) if (cwd === id) this.metaIdToCwd.delete(mid);
    return v;
  }

  /** Wrapped session (`tlive run`): upsert kind=wrapped + sockPath, keyed by cwd. */
  register(meta: SessionMeta): SessionView {
    this.metaIdToCwd.set(meta.id, meta.cwd);
    return this.upsert({ cwd: meta.cwd, label: meta.label, kind: 'wrapped', sockPath: meta.sockPath, status: 'active' });
  }

  /** `tlive run` exit: remove the wrapped session by its (uuid) meta id. */
  unregister(metaId: string): SessionView | undefined {
    const cwd = this.metaIdToCwd.get(metaId);
    if (cwd === undefined) return undefined;
    return this.remove(cwd);
  }

  get(id: string): SessionView | undefined {
    return this.byCwd.get(id);
  }
  list(): SessionView[] {
    return [...this.byCwd.values()];
  }
}
