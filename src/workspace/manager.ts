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
  }

  clearActiveSession(workspaceId: string): void {
    const ws = this.byId.get(workspaceId);
    if (!ws) return;
    ws.activeSessionId = null;
  }

  getActiveSessionId(workspaceId: string): string | null {
    return this.byId.get(workspaceId)?.activeSessionId ?? null;
  }

  // ---- Bindings -------------------------------------------------------------

  addBinding(workspaceId: string, binding: ChatBinding): Workspace {
    const ws = this.byId.get(workspaceId);
    if (!ws) throw new Error(`addBinding: workspace ${workspaceId} not found`);
    ws.bindings = addBindingPure(ws.bindings, binding);
    return ws;
  }

  removeBinding(workspaceId: string, key: { channelType: ChannelType; chatId: string }): Workspace | undefined {
    const ws = this.byId.get(workspaceId);
    if (!ws) return undefined;
    ws.bindings = removeBindingPure(ws.bindings, key);
    return ws;
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
   * Plain-text IM flow. Three branches:
   *   (1) activeSessionId set + live → sendInput
   *   (2) activeSessionId set + stopped (meta exists) → resume; on success sendInput
   *   (3) else → createLocal with workspace defaults
   *
   * Returns a tagged outcome so callers can message the user contextually.
   */
  async lazyResumeOrCreate(
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
      await deps.sendInput(active, initialPrompt, source);
      // Caller should provide SessionLike via its own manager.get(); we only
      // expose action + a minimal stub so IM can signal to the user.
      const session = await this.fetchLiveOrThrow(active, deps);
      return { action: 'sent_to_live', session };
    }

    // Branch 2: stopped session, try resume
    if (active) {
      const resumed = await deps.resume(active);
      if (resumed) {
        try { this.bindActiveSession(workspaceId, resumed.id); }
        catch { /* conflict: race with concurrent create; fall through */ }
        await deps.sendInput(resumed.id, initialPrompt, source);
        return { action: 'resumed', session: resumed };
      }
    }

    // Branch 3: fresh create
    const created = await deps.createLocal({
      workspaceId,
      provider: ws.defaults.provider,
      workdir: ws.workdir,
      initialPrompt,
      source,
    });
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
      workspaces: [...this.byId.values()].map((ws) => ({
        ...ws,
        // activeSessionId is runtime-only; don't persist it
        activeSessionId: null,
      })),
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
          this.byId.set(ws.id, { ...ws, activeSessionId: null });
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
