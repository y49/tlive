// src/workspace/manager.ts
//
// v1.0 WorkspaceManager (spec §6.1). Owns:
//   - per-user roles (admin/operator/observer) — T4 enforces, this stores
//   - multi-chat bindings (each ChatBinding owns its own activeSessionId
//     per docs/superpowers/specs/2026-05-07-isolated-chat-sessions-design.md
//     §3 — chats are isolated; no fan-out)
//   - lazyResumeOrCreate — Mode A plain-text IM flow (spec §6.1 step 3)
//   - per-workspace defaults, budget, mcpServers
//
// Chat-level activeSessionId is the only session-binding API: see
// bindActiveSessionForChat / clearActiveSessionForChat /
// getActiveSessionIdForChat. The legacy ws-level methods were removed
// in Iso #3.

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
  findBinding,
} from './chat-instance.js';

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
    channelType: ChannelType;
    chatId: string;
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

  // ---- Bindings -------------------------------------------------------------

  addBinding(
    workspaceId: string,
    binding: Omit<ChatBinding, 'activeSessionId'> & { activeSessionId?: string | null },
  ): Workspace {
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
  // these are the only session-binding APIs. The previous ws-level
  // bindActiveSession / clearActiveSession / getActiveSessionId trio was
  // deleted in Iso #3.

  bindActiveSessionForChat(
    channelType: ChannelType,
    chatId: string,
    sdkSessionId: string,
  ): void {
    const found = this.findBindingWithWorkspace(channelType, chatId);
    if (!found) {
      throw new Error(`bindActiveSessionForChat: no binding for ${channelType}:${chatId}`);
    }
    found.binding.activeSessionId = sdkSessionId;
    found.binding.lastActiveAt = new Date().toISOString();
    void this.save().catch(() => undefined);
  }

  clearActiveSessionForChat(channelType: ChannelType, chatId: string): void {
    const found = this.findBindingWithWorkspace(channelType, chatId);
    if (!found) return;
    found.binding.activeSessionId = null;
    void this.save().catch(() => undefined);
  }

  getActiveSessionIdForChat(channelType: ChannelType, chatId: string): string | null {
    const found = this.findBindingWithWorkspace(channelType, chatId);
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

  private findBindingWithWorkspace(
    channelType: ChannelType,
    chatId: string,
  ): { workspace: Workspace; binding: ChatBinding } | undefined {
    for (const ws of this.byId.values()) {
      const binding = findBinding(ws.bindings, { channelType, chatId });
      if (binding) return { workspace: ws, binding };
    }
    return undefined;
  }

  listBindings(workspaceId: string): ChatBinding[] {
    return this.byId.get(workspaceId)?.bindings ?? [];
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
   * Per-chat serialization for lazyResumeOrCreate. Two near-simultaneous
   * inbound messages on the same chat would otherwise both observe
   * `activeSessionId === null`, both take branch 3, and create two sessions —
   * the user sees N parallel session headers for one chat. Chain calls so the
   * second one observes the first's bindActiveSession.
   *
   * Per-chat (not per-workspace) because chats now own sessions: two chats
   * bound to the same workspace must NOT serialize against each other —
   * each has its own activeSessionId and runs concurrently.
   */
  private readonly lazyChain = new Map<string, Promise<unknown>>();

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
   * Per-chat serialized — concurrent calls for the same (channelType, chatId)
   * await each other rather than racing on activeSessionId reads.
   *
   * Throws if no binding exists for (channelType, chatId); callers should
   * pre-check via findByChat and surface a friendlier "select workspace"
   * prompt instead of relying on this throw.
   */
  async lazyResumeOrCreate(
    channelType: ChannelType,
    chatId: string,
    text: string,
    source: 'im' | 'cli',
    deps: LazyResumeDeps,
  ): Promise<LazyResumeOutcome> {
    const found = this.findBindingWithWorkspace(channelType, chatId);
    if (!found) {
      throw new Error(`lazyResumeOrCreate: chat ${channelType}:${chatId} not bound to any workspace`);
    }
    // Per-chat serialization (was per-workspace before — chats now own sessions
    // so chats are the right granularity for chain ordering).
    const chainKey = `${channelType}:${chatId}`;
    const previous = this.lazyChain.get(chainKey) ?? Promise.resolve();
    const next = previous.then(async () =>
      this.lazyResumeOrCreateInner(found.workspace, found.binding, text, source, deps),
    );
    this.lazyChain.set(chainKey, next.catch(() => undefined));
    return next;
  }

  private async lazyResumeOrCreateInner(
    workspace: Workspace,
    binding: ChatBinding,
    text: string,
    source: 'im' | 'cli',
    deps: LazyResumeDeps,
  ): Promise<LazyResumeOutcome> {
    const activeId = binding.activeSessionId;
    if (activeId) {
      if (deps.isLive(activeId)) {
        await deps.sendInput(activeId, text, source);
        deps.onBranch?.({ branch: 'live', sessionId: activeId, workspaceId: workspace.id });
        return { action: 'sent_to_live', session: { id: activeId, kind: 'local' } as SessionLike };
      }
      if (await deps.hasPersistedSession(activeId)) {
        let resumed: SessionLike | null = null;
        let err: Error | null = null;
        try {
          resumed = await deps.resume(activeId);
        } catch (e) {
          err = e instanceof Error ? e : new Error(String(e));
        }
        if (resumed) {
          await deps.sendInput(resumed.id, text, source);
          binding.activeSessionId = resumed.id;
          binding.lastActiveAt = new Date().toISOString();
          void this.save().catch(() => undefined);
          deps.onBranch?.({ branch: 'resumed', sessionId: resumed.id, workspaceId: workspace.id });
          return { action: 'resumed', session: resumed };
        }
        deps.onResumeFailed?.({
          channelType: binding.channelType,
          chatId: binding.chatId,
          workspaceId: workspace.id,
          sdkSessionId: activeId,
          reason: err ? err.message : 'resume returned null',
        });
      }
      binding.activeSessionId = null;
    }

    const session = await deps.createLocal({
      workspaceId: workspace.id,
      provider: workspace.defaults.provider,
      workdir: workspace.workdir,
      initialPrompt: text,
      source,
    });
    binding.activeSessionId = session.id;
    binding.lastActiveAt = new Date().toISOString();
    void this.save().catch(() => undefined);
    deps.onBranch?.({ branch: 'created', sessionId: session.id, workspaceId: workspace.id });
    return { action: 'created', session };
  }

  // ---- Persistence ---------------------------------------------------------

  async save(): Promise<void> {
    if (!this.persistPath) return;
    const path = this.persistPath;
    await fs.mkdir(dirname(path), { recursive: true });
    const payload = {
      version: 1,
      // Each binding's activeSessionId IS persisted so the user's IM thread
      // keeps the same session id across daemon restarts. lazyResumeOrCreate's
      // branch 2 (active && !isLive → resume) reattaches via runtime.prepare's
      // resumeSessionId option. If resume fails for a stale id, the same
      // function safely falls through to branch 3 createLocal.
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
          // Per chat-level isolation (Iso #1), activeSessionId now lives on
          // each ChatBinding rather than the Workspace. The bindings array
          // round-trips verbatim, so each binding's activeSessionId is
          // preserved across daemon restart. If an id turns out stale on
          // resume, lazyResumeOrCreate falls through to createLocal — so
          // restoring is robust regardless of session state.
          this.byId.set(ws.id, { ...ws });
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
