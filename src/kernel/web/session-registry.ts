//
// In-memory rich registry of AI-coding sessions.
// Keying: wrapped sessions (`tlive run`) key by their run uuid — several may
// share one cwd; hook-only sessions key by cwd (hooks carry nothing better).
// Hook traffic from INSIDE a wrapped pty carries TLIVE_SESSION and is routed
// to that exact card by the daemon. Vendor-neutral; stores only current state
// per session — never history/timelines. Staleness ("stuck Nm") is computed
// by the frontend from lastActivityAt; this layer only stores the timestamp.

import { basename } from 'node:path';
import type { SessionMeta } from '../ipc/protocol.js';

export type SessionStatus = 'active' | 'waiting-approval' | 'waiting-input' | 'idle';
export type SessionKind = 'wrapped' | 'hook';

export interface PendingApproval {
  requestId: string;
  title: string;
  body: string;
  toolName?: string; // for "always allow <tool>" actions
}

export interface SessionView {
  id: string; // wrapped: run uuid; hook-only: cwd
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
  pid?: number; // wrapped sessions only (`tlive run` process — liveness sweep)
  startedAt?: number; // wrapped sessions only — ms epoch, for uptime
}

export interface UpsertPatch {
  /** Registry key. Defaults to cwd (hook-only sessions). */
  key?: string;
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
  pid?: number;
  startedAt?: number;
}

export class SessionRegistry {
  private byKey = new Map<string, SessionView>();

  /** Merge a patch into the session under `key ?? cwd`; create it if absent. */
  upsert(patch: UpsertPatch): SessionView {
    const key = patch.key ?? patch.cwd;
    const prev = this.byKey.get(key);
    const cwd = prev?.cwd ?? patch.cwd; // the display cwd never mutates after creation
    const next: SessionView = {
      id: key,
      cwd,
      label: patch.label ?? prev?.label ?? (basename(cwd) || cwd),
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
    const pid = patch.pid ?? prev?.pid;
    if (pid !== undefined) next.pid = pid;
    const startedAt = patch.startedAt ?? prev?.startedAt;
    if (startedAt !== undefined) next.startedAt = startedAt;
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
    this.byKey.set(key, next);
    return next;
  }

  /** Toggle per-session mute; returns the updated view, or undefined if absent. */
  setMuted(id: string, muted: boolean): SessionView | undefined {
    const prev = this.byKey.get(id);
    if (!prev) return undefined;
    const next = { ...prev, muted };
    this.byKey.set(id, next);
    return next;
  }

  /** Remove by id. Returns the removed view for broadcast, or undefined. */
  remove(id: string): SessionView | undefined {
    const v = this.byKey.get(id);
    if (!v) return undefined;
    this.byKey.delete(id);
    return v;
  }

  /** Wrapped session (`tlive run`): keyed by its run uuid — several wrapped
   *  sessions may share one cwd. */
  register(meta: SessionMeta): SessionView {
    return this.upsert({ key: meta.id, cwd: meta.cwd, label: meta.label, kind: 'wrapped', sockPath: meta.sockPath, pid: meta.pid, ...(meta.startedAt !== undefined ? { startedAt: meta.startedAt } : {}), status: 'active' });
  }

  /** `tlive run` exit: remove the wrapped session by its (uuid) meta id. */
  unregister(metaId: string): SessionView | undefined {
    return this.remove(metaId);
  }

  get(id: string): SessionView | undefined {
    return this.byKey.get(id);
  }
  list(): SessionView[] {
    return [...this.byKey.values()];
  }
}
