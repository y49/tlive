// src/workspace/manager.ts
//
// v1.0 WorkspaceManager (spec §6.1). Absorbs the legacy bridge
// `engine/workspace-manager.ts` responsibilities (register / openByName /
// openByPath / findByWorkdir / lazyBind / persist) and layers on:
//   - activeSessionId single-writer enforcement (loud fail on conflict)
//   - per-user roles (admin/operator/observer) — T4 enforces, this stores
//   - multi-chat bindings primary/mirror — drives T6 fan-out rendering
//   - lazyResumeOrCreate — Mode A plain-text IM flow (spec §6.1 step 3)
//   - per-workspace defaults, budget, mcpServers
//
// Reimplemented from scratch for v1.0. The v0.x `bridge/` tree is gone
// (deleted in T8); this is now the sole WorkspaceManager in the codebase.

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentProvider } from '../runtime/types.js';
import type { SessionLike } from './../session/types.js';
import {
  type Workspace, type WorkspaceDefaults, type WorkspaceBudget, type Role,
  defaultWorkspaceDefaults,
} from './config.js';
import {
  type ChatBinding, type ChannelType, addBinding as addBindingPure, removeBinding as removeBindingPure,
  partitionBindings, findBinding,
} from './bindings.js';

export class WorkspaceConflictError extends Error {
  constructor(workspaceId: string, current: string, incoming: string) {
    super(`workspace ${workspaceId}: activeSessionId=${current} refuses to yield to ${incoming}`);
    this.name = 'WorkspaceConflictError';
  }
}

export interface WorkspaceManagerOptions {
  /** JSON file to persist workspaces. `null` disables persistence. */
  persistPath?: string | null;
}

export interface LazyResumeDeps {
  /** Check whether a session id is still live. */
  isLive: (sdkSessionId: string) => boolean;
  /**
   * Cheap on-disk probe — does a persisted snapshot/jsonl exist for this
   * session id? When isLive returns false but hasPersistedSession returns
   * true, lazyResumeOrCreate takes the resume branch instead of silently
   * creating a fresh session and losing history. Three triggers share this
   * path: daemon restart (sessions Map empty), workspace switch (explicit
   * stop), IdleStop 24h (auto stop).
   */
  hasPersistedSession: (sdkSessionId: string) => boolean | Promise<boolean>;
  /** Attempt to resume a stopped session; return the resumed SessionLike or null. */
  resume: (sdkSessionId: string) => Promise<SessionLike | null>;
  /** Forward a text input to the live session. */
  sendInput: (sdkSessionId: string, text: string, source: 'im' | 'cli') => Promise<void>;
  /** Create a new local session with the workspace's defaults. */
  createLocal: (opts: {
    workspaceId: string;
    provider: AgentProvider;
    workdir: string;
    initialPrompt?: string;
    source: 'im' | 'cli';
  }) => Promise<SessionLike>;
  /** Optional log hook fired right after the branch decision. Bootstrap wires
   *  to its structured logger; tests may omit. */
  onBranch?: (info: { branch: 'live' | 'resumed' | 'created'; sessionId: string; workspaceId: string }) => void;
  /** Called when resume was attempted (jsonl exists) but failed (null
   *  or thrown). Fired before fall-through to createLocal so callers
   *  can log/alert. Best-effort — must not throw. */
  onResumeFailed?: (info: {
    workspaceId: string;
    sdkSessionId: string;
    reason: string;
  }) => void;
}

export type LazyResumeOutcome =
  | { action: 'sent_to_live'; session: SessionLike }
  | { action: 'resumed'; session: SessionLike }
  | { action: 'created'; session: SessionLike };

/**
 * WorkspaceManager — indexed by `id` (UUID). Name is for display only and
 * can collide across the life of the daemon, though callers typically
 * dedupe by workdir.
 */
export class WorkspaceManager {
  private byId = new Map<string, Workspace>();
  private readonly persistPath: string | null;

  constructor(opts: WorkspaceManagerOptions = {}) {
    this.persistPath = opts.persistPath ?? null;
  }

  // ---- Creation / lookup ----------------------------------------------------

  create(input: {
    name: string;
    workdir: string;
    gitRemote?: string;
    defaults?: Partial<WorkspaceDefaults>;
    budget?: WorkspaceBudget;
    defaultRole?: Role;
  }): Workspace {
    const id = randomUUID();
    const defaults: WorkspaceDefaults = {
      ...defaultWorkspaceDefaults(input.defaults?.provider ?? 'claude'),
      ...input.defaults,
    };
    const ws: Workspace = {
      id,
      name: input.name,
      workdir: input.workdir,
      gitRemote: input.gitRemote,
      activeSessionId: null,
      defaults,
      budget: input.budget ?? {},
      mcpServers: {},
      roles: {},
      defaultRole: input.defaultRole ?? 'observer',
      bindings: [],
      createdAt: new Date().toISOString(),
    };
    this.byId.set(id, ws);
    return ws;
  }

  /**
   * Atomic helper for IM-driven onboarding (spec §8 step 5). Creates the
   * workspace, claims the user as admin, and adds the primary chat binding
   * in one call so callers (bootstrap inbound dialog, IPC workspace.add)
   * don't repeat the 4-line dance.
   */
  createFromIM(opts: {
    workdir: string;
    adminUserId: string;
    channelType: ChannelType;
    chatId: string;
    threadId?: string;
    /** Defaults to basename(workdir) */
    name?: string;
    /** Optional partial defaults override (e.g. provider, model) */
    defaults?: Partial<WorkspaceDefaults>;
  }): Workspace {
    const ws = this.create({
      name: opts.name ?? basename(opts.workdir),
      workdir: opts.workdir,
      defaults: opts.defaults,
    });
    this.setRole(ws.id, opts.adminUserId, 'admin');
    this.addBinding(ws.id, {
      channelType: opts.channelType,
      chatId: opts.chatId,
      threadId: opts.threadId,
      role: 'primary',
    });
    return ws;
  }

  get(id: string): Workspace | undefined { return this.byId.get(id); }

  findByName(name: string): Workspace | undefined {
    for (const ws of this.byId.values()) if (ws.name === name) return ws;
    return undefined;
  }

  findByWorkdir(workdir: string): Workspace | undefined {
    for (const ws of this.byId.values()) if (ws.workdir === workdir) return ws;
    return undefined;
  }

  list(): Workspace[] { return [...this.byId.values()]; }

  /** Find the workspace that owns a given chat binding. */
  findByChat(channelType: ChannelType, chatId: string): Workspace | undefined {
    for (const ws of this.byId.values()) {
      if (findBinding(ws.bindings, { channelType, chatId })) return ws;
    }
    return undefined;
  }

  /** In-place mutation helper used by config update flows. */
  update(id: string, patch: Partial<Omit<Workspace, 'id'>>): Workspace | undefined {
    const ws = this.byId.get(id);
    if (!ws) return undefined;
    Object.assign(ws, patch);
    return ws;
  }

  delete(id: string): boolean { return this.byId.delete(id); }

  // ---- activeSessionId: single-writer -----------------------------------

  /**
   * Claim a workspace's active session slot. If a *different* non-null
   * session is currently bound, throws WorkspaceConflictError to surface
   * the invariant violation loudly. Callers must clearActiveSession first
   * if they know the incumbent is defunct.
   */
  bindActiveSession(workspaceId: string, sdkSessionId: string): void {
    const ws = this.byId.get(workspaceId);
    if (!ws) throw new Error(`bindActiveSession: workspace ${workspaceId} not found`);
    if (ws.activeSessionId && ws.activeSessionId !== sdkSessionId) {
      throw new WorkspaceConflictError(workspaceId, ws.activeSessionId, sdkSessionId);
    }
    ws.activeSessionId = sdkSessionId;
    // Fire-and-forget persist so a daemon crash/SIGKILL doesn't lose the
    // workspace→session binding; without this, only graceful shutdown
    // wrote activeSessionId to disk and any abnormal exit reset chat
    // continuity to "no active session" → user sees a new session id on
    // next message.
    void this.save().catch(() => undefined);
  }

  clearActiveSession(workspaceId: string): void {
    const ws = this.byId.get(workspaceId);
    if (!ws) return;
    ws.activeSessionId = null;
    void this.save().catch(() => undefined);
  }

  getActiveSessionId(workspaceId: string): string | null {
    return this.byId.get(workspaceId)?.activeSessionId ?? null;
  }

  // ---- Bindings -------------------------------------------------------------

  addBinding(workspaceId: string, binding: ChatBinding): Workspace {
    const ws = this.byId.get(workspaceId);
    if (!ws) throw new Error(`addBinding: workspace ${workspaceId} not found`);
    // Defensive: refuse empty chatId. A previous bug where the Feishu
    // adapter parsed open_chat_id from the wrong payload location (fixed
    // in 4e5724e) silently stored chatId="" entries here, which then
    // crashed the frontend fan-out with API 400. Rejecting at this
    // boundary prevents data corruption regardless of caller hygiene.
    if (!binding.chatId) {
      throw new Error(`addBinding: chatId is required (got empty for ${binding.channelType})`);
    }
    ws.bindings = addBindingPure(ws.bindings, binding);
    return ws;
  }

  removeBinding(workspaceId: string, key: { channelType: ChannelType; chatId: string }): Workspace | undefined {
    const ws = this.byId.get(workspaceId);
    if (!ws) return undefined;
    ws.bindings = removeBindingPure(ws.bindings, key);
    return ws;
  }

  // ---- Chat-level session APIs (spec §4.1) ---------------------------------
  //
  // Per docs/superpowers/specs/2026-05-07-isolated-chat-sessions-design.md §4.1.
  // Each chat owns its own SDK session via ChatBinding.activeSessionId, so
  // these are the per-binding analogues of the (deprecated) ws-level
  // bindActiveSession / clearActiveSession / getActiveSessionId trio. The
  // ws-level methods remain in place for one task window so callers can
  // migrate; Iso #3 deletes them.

  bindActiveSessionForChat(
    channelType: ChannelType,
    chatId: string,
    sdkSessionId: string,
  ): void {
    const found = this.findBindingMutable(channelType, chatId);
    if (!found) {
      throw new Error(`bindActiveSessionForChat: no binding for ${channelType}:${chatId}`);
    }
    found.binding.activeSessionId = sdkSessionId;
    found.binding.lastActiveAt = new Date().toISOString();
    void this.save().catch(() => undefined);
  }

  clearActiveSessionForChat(channelType: ChannelType, chatId: string): void {
    const found = this.findBindingMutable(channelType, chatId);
    if (!found) return;
    found.binding.activeSessionId = null;
    void this.save().catch(() => undefined);
  }

  getActiveSessionIdForChat(channelType: ChannelType, chatId: string): string | null {
    const found = this.findBindingMutable(channelType, chatId);
    return found?.binding.activeSessionId ?? null;
  }

  /**
   * Flat list of every binding with a non-null activeSessionId across all
   * workspaces. Drives IdleStop's per-binding scan and the daemon-restart
   * auto-resume sweep — both want a single iteration regardless of how
   * many workspaces or chats are configured.
   */
  listActiveBindings(): Array<{
    channelType: ChannelType;
    chatId: string;
    workspaceId: string;
    activeSessionId: string;
    lastActiveAt: string;
  }> {
    const out: Array<{
      channelType: ChannelType;
      chatId: string;
      workspaceId: string;
      activeSessionId: string;
      lastActiveAt: string;
    }> = [];
    for (const ws of this.byId.values()) {
      for (const b of ws.bindings) {
        if (!b.activeSessionId) continue;
        out.push({
          channelType: b.channelType,
          chatId: b.chatId,
          workspaceId: ws.id,
          activeSessionId: b.activeSessionId,
          lastActiveAt: b.lastActiveAt ?? new Date(0).toISOString(),
        });
      }
    }
    return out;
  }

  private findBindingMutable(
    channelType: ChannelType,
    chatId: string,
  ): { workspace: Workspace; binding: ChatBinding } | undefined {
    for (const ws of this.byId.values()) {
      for (const b of ws.bindings) {
        if (b.channelType === channelType && b.chatId === chatId) {
          return { workspace: ws, binding: b };
        }
      }
    }
    return undefined;
  }

  listBindings(workspaceId: string): ChatBinding[] {
    return this.byId.get(workspaceId)?.bindings ?? [];
  }

  /** Convenience: {primary, mirrors, all}. */
  partitionBindings(workspaceId: string): ReturnType<typeof partitionBindings> {
    return partitionBindings(this.byId.get(workspaceId)?.bindings ?? []);
  }

  // ---- Roles ---------------------------------------------------------------

  setRole(workspaceId: string, userId: string, role: Role): void {
    const ws = this.byId.get(workspaceId);
    if (!ws) throw new Error(`setRole: workspace ${workspaceId} not found`);
    ws.roles[userId] = role;
  }

  getRole(workspaceId: string, userId: string): Role {
    const ws = this.byId.get(workspaceId);
    if (!ws) return 'observer';
    return ws.roles[userId] ?? ws.defaultRole;
  }

  /**
   * Promote `userId` to admin role on the workspace, but only if no admin
   * exists yet. Idempotent. Returns true when the role was actually set,
   * false when an admin (any user, including this one already) was present.
   *
   * Used by bootstrap to convert config-declared `adminUserId` into a real
   * role assignment without trampling existing admin assignments persisted
   * in workspaces.json.
   */
  claimAdmin(workspaceId: string, userId: string): boolean {
    const ws = this.byId.get(workspaceId);
    if (!ws) throw new Error(`claimAdmin: workspace ${workspaceId} not found`);
    for (const role of Object.values(ws.roles)) {
      if (role === 'admin') return false;
    }
    ws.roles[userId] = 'admin';
    return true;
  }

  // ---- lazyResumeOrCreate (spec §6.1) --------------------------------------

  /**
   * Per-workspace serialization for lazyResumeOrCreate. Two near-simultaneous
   * inbound messages on the same workspace would otherwise both observe
   * `activeSessionId === null`, both take branch 3, and create two sessions —
   * the user sees N parallel session headers for one chat. Chain calls so the
   * second one observes the first's bindActiveSession.
   */
  private readonly lazyResumeChain = new Map<string, Promise<unknown>>();

  /**
   * Plain-text IM flow. Three branches:
   *   (1) activeSessionId set + live → sendInput
   *   (2) activeSessionId set + !isLive + hasPersistedSession → resume + sendInput
   *   (3) else → createLocal with workspace defaults
   *
   * Branch (2) is the `claude -r` semantic: process is ephemeral, jsonl is
   * source of truth. After daemon restart / workspace switch / IdleStop the
   * LocalSession instance is gone but the on-disk jsonl persists, so we
   * resume rather than silently dropping the conversation history. If
   * resume() returns null (corrupt jsonl etc.) we fall through to (3) as a
   * final safety net.
   *
   * Returns a tagged outcome so callers can message the user contextually.
   *
   * Per-workspace serialized — concurrent calls for the same workspaceId
   * await each other rather than racing on activeSessionId reads.
   */
  async lazyResumeOrCreate(
    workspaceId: string,
    initialPrompt: string,
    source: 'im' | 'cli',
    deps: LazyResumeDeps,
  ): Promise<LazyResumeOutcome> {
    const prev = this.lazyResumeChain.get(workspaceId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.lazyResumeOrCreateInner(workspaceId, initialPrompt, source, deps));
    this.lazyResumeChain.set(workspaceId, next);
    try {
      return await next;
    } finally {
      // Drop the chain entry once it completes if no follower took it over;
      // a follower would have already replaced the entry via .set above.
      if (this.lazyResumeChain.get(workspaceId) === next) {
        this.lazyResumeChain.delete(workspaceId);
      }
    }
  }

  private async lazyResumeOrCreateInner(
    workspaceId: string,
    initialPrompt: string,
    source: 'im' | 'cli',
    deps: LazyResumeDeps,
  ): Promise<LazyResumeOutcome> {
    const ws = this.byId.get(workspaceId);
    if (!ws) throw new Error(`lazyResumeOrCreate: workspace ${workspaceId} not found`);

    // Branch 1: live session exists
    const active = ws.activeSessionId;
    if (active && deps.isLive(active)) {
      deps.onBranch?.({ branch: 'live', sessionId: active, workspaceId });
      await deps.sendInput(active, initialPrompt, source);
      // Caller should provide SessionLike via its own manager.get(); we only
      // expose action + a minimal stub so IM can signal to the user.
      const session = await this.fetchLiveOrThrow(active, deps);
      return { action: 'sent_to_live', session };
    }

    // Branch 2: process is dead, but jsonl on disk → resume from persisted state.
    // hasPersistedSession is a cheap probe (single fs.access in production);
    // gating resume() on it avoids spurious runtime spin-up when activeSessionId
    // points at a stale id that was wiped from disk.
    if (active && (await deps.hasPersistedSession(active))) {
      let resumed: SessionLike | null = null;
      let resumeError: Error | null = null;
      try {
        resumed = await deps.resume(active);
      } catch (err) {
        resumeError = err instanceof Error ? err : new Error(String(err));
      }
      if (resumed) {
        deps.onBranch?.({ branch: 'resumed', sessionId: resumed.id, workspaceId });
        try { this.bindActiveSession(workspaceId, resumed.id); }
        catch { /* conflict: race with concurrent create; fall through */ }
        await deps.sendInput(resumed.id, initialPrompt, source);
        return { action: 'resumed', session: resumed };
      }
      // resume returned null OR threw — log the abandonment via the
      // optional onResumeFailed hook so operators have a forensic trail
      // (otherwise the user silently gets a fresh session).
      deps.onResumeFailed?.({
        workspaceId,
        sdkSessionId: active,
        reason: resumeError ? resumeError.message : 'resume returned null',
      });
      // fall through to createLocal (safety net)
    }

    // Branch 3: fresh create. If we fell through here while a stale activeSessionId
    // is still bound (no jsonl on disk, or resume returned null), clear it first so
    // the bindActiveSession below doesn't trip the single-writer conflict guard.
    if (active) this.clearActiveSession(workspaceId);
    const created = await deps.createLocal({
      workspaceId,
      provider: ws.defaults.provider,
      workdir: ws.workdir,
      initialPrompt,
      source,
    });
    deps.onBranch?.({ branch: 'created', sessionId: created.id, workspaceId });
    this.bindActiveSession(workspaceId, created.id);
    return { action: 'created', session: created };
  }

  private async fetchLiveOrThrow(sdkId: string, deps: LazyResumeDeps): Promise<SessionLike> {
    const resumed = await deps.resume(sdkId);
    if (resumed) return resumed;
    throw new Error(`lazyResumeOrCreate: session ${sdkId} advertised live but not resolvable`);
  }

  // ---- Persistence ---------------------------------------------------------

  async save(): Promise<void> {
    if (!this.persistPath) return;
    const path = this.persistPath;
    await fs.mkdir(dirname(path), { recursive: true });
    const payload = {
      version: 1,
      // activeSessionId IS persisted so the user's IM thread keeps the same
      // session id across daemon restarts. lazyResumeOrCreate's branch 2
      // (active && !isLive → resume) reattaches via runtime.prepare's
      // resumeSessionId option (T3 plumbed end-to-end). If resume fails for
      // a stale id, the same function safely falls through to branch 3
      // createLocal — so persistence is robust against crashed sessions.
      workspaces: [...this.byId.values()].map((ws) => ({ ...ws })),
    };
    await fs.writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  }

  async load(): Promise<void> {
    if (!this.persistPath) return;
    let raw: string;
    try { raw = await fs.readFile(this.persistPath, 'utf8'); }
    catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as { workspaces?: Workspace[] };
      if (!Array.isArray(parsed.workspaces)) return;
      for (const ws of parsed.workspaces) {
        if (typeof ws.id === 'string' && typeof ws.name === 'string' && typeof ws.workdir === 'string') {
          // activeSessionId IS preserved on load — its persistence (added in
          // de2c6db) only matters if load() round-trips it. lazyResumeOrCreate
          // observes isLive=false on a freshly-booted daemon (sessions Map
          // empty) and takes branch 2 (hasPersistedSession → resume) using
          // this id. If the id is stale, branch 2 falls through to branch 3
          // createLocal — so preserving it is robust against crashed sessions.
          this.byId.set(ws.id, { ...ws, activeSessionId: ws.activeSessionId ?? null });
        }
      }
    } catch {
      // Corrupt file — caller can inspect; don't throw so daemon keeps booting.
    }
  }

  // ---- Convenience ---------------------------------------------------------

  /** Auto-create a workspace from a workdir if none is registered. */
  ensureForWorkdir(workdir: string, provider: AgentProvider = 'claude'): Workspace {
    const existing = this.findByWorkdir(workdir);
    if (existing) return existing;
    const name = basename(workdir) || 'workspace';
    return this.create({ name, workdir, defaults: { provider } });
  }
}
