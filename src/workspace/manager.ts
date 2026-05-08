// src/workspace/manager.ts
//
// v1.0 WorkspaceManager (spec 2026-05-08 §3 / §4 / §6).
//
// Owns:
//   - workspaces: Map<id, Workspace> — pure project templates
//   - chatInstances: top-level array — one per (channelType, chatId)
//     Each ChatInstance owns activeSessionId / costRollup / optional
//     settings override.
//   - lazyResumeOrCreate (spec §6.1 step 3 unchanged shape, but resolves
//     workspace via ChatInstance now).
//
// chat-trust: anyone in a bound chat drives the bot. No roles or admin concept.

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentProvider } from '../runtime/types.js';
import type { SessionLike } from './../session/types.js';
import {
  type Workspace, type WorkspaceDefaults, type WorkspaceBudget,
  defaultWorkspaceDefaults,
} from './config.js';
import {
  type ChatInstance, type ChannelType,
  addChatInstance, removeChatInstance, findChatInstance, newCostRollup,
} from './chat-instance.js';

export interface WorkspaceManagerOptions {
  persistPath?: string | null;
}

export interface LazyResumeDeps {
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

const SCHEMA_VERSION = 2;

export class WorkspaceManager {
  private byId = new Map<string, Workspace>();
  private chatInstances: ChatInstance[] = [];
  private readonly persistPath: string | null;

  constructor(opts: WorkspaceManagerOptions = {}) {
    this.persistPath = opts.persistPath ?? null;
  }

  // ---- Workspace template CRUD ---------------------------------------------

  create(input: {
    name: string;
    workdir: string;
    gitRemote?: string;
    defaults?: Partial<WorkspaceDefaults>;
    budget?: WorkspaceBudget;
  }): Workspace {
    const id = randomUUID();
    const ws: Workspace = {
      id,
      name: input.name,
      workdir: input.workdir,
      gitRemote: input.gitRemote,
      defaults: { ...defaultWorkspaceDefaults(input.defaults?.provider ?? 'claude'), ...input.defaults },
      budget: input.budget ?? {},
      mcpServers: {},
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

  update(id: string, patch: Partial<Omit<Workspace, 'id'>>): Workspace | undefined {
    const ws = this.byId.get(id);
    if (!ws) return undefined;
    Object.assign(ws, patch);
    return ws;
  }

  /**
   * Default refuses if any ChatInstance still references the workspace.
   * `--force` cascades: returns the removed Workspace plus the list of
   * removed ChatInstances so callers can stop their sessions and notify
   * users.
   */
  removeWorkspace(id: string, opts: { force?: boolean } = {}): {
    workspace: Workspace | undefined;
    chatInstances: ChatInstance[];
  } {
    const ws = this.byId.get(id);
    if (!ws) return { workspace: undefined, chatInstances: [] };
    const bound = this.chatInstances.filter((c) => c.workspaceId === id);
    if (bound.length > 0 && !opts.force) {
      throw new Error(`removeWorkspace: ${bound.length} chat(s) still bound; pass force or unbind first`);
    }
    this.chatInstances = this.chatInstances.filter((c) => c.workspaceId !== id);
    this.byId.delete(id);
    void this.save().catch(() => undefined);
    return { workspace: ws, chatInstances: bound };
  }

  // ---- ChatInstance lifecycle ----------------------------------------------

  bindChat(input: {
    workspaceId: string;
    channelType: ChannelType;
    chatId: string;
    threadId?: string;
  }): ChatInstance {
    const ws = this.byId.get(input.workspaceId);
    if (!ws) throw new Error(`bindChat: workspace ${input.workspaceId} not found`);
    const existing = findChatInstance(this.chatInstances, input);
    if (existing) {
      throw new Error(`bindChat: ${input.channelType}:${input.chatId} already bound to ${existing.workspaceId}`);
    }
    const now = new Date().toISOString();
    const inst: ChatInstance = {
      channelType: input.channelType,
      chatId: input.chatId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      activeSessionId: null,
      lastActiveAt: null,
      costRollup: newCostRollup(now),
      createdAt: now,
    };
    this.chatInstances = addChatInstance(this.chatInstances, inst);
    void this.save().catch(() => undefined);
    return inst;
  }

  unbindChat(channelType: ChannelType, chatId: string): ChatInstance | undefined {
    const inst = findChatInstance(this.chatInstances, { channelType, chatId });
    if (!inst) return undefined;
    this.chatInstances = removeChatInstance(this.chatInstances, { channelType, chatId });
    void this.save().catch(() => undefined);
    return inst;
  }

  /**
   * Atomic: unbind from current ws + bind to new ws. costRollup resets,
   * activeSessionId clears. Throws if chat has no current binding.
   */
  switchChat(channelType: ChannelType, chatId: string, newWorkspaceId: string): ChatInstance {
    const current = findChatInstance(this.chatInstances, { channelType, chatId });
    if (!current) {
      throw new Error(`switchChat: ${channelType}:${chatId} not currently bound`);
    }
    if (!this.byId.get(newWorkspaceId)) {
      throw new Error(`switchChat: workspace ${newWorkspaceId} not found`);
    }
    this.chatInstances = removeChatInstance(this.chatInstances, { channelType, chatId });
    return this.bindChat({
      workspaceId: newWorkspaceId,
      channelType,
      chatId,
      threadId: current.threadId,
    });
  }

  findChatInstance(channelType: ChannelType, chatId: string): ChatInstance | undefined {
    return findChatInstance(this.chatInstances, { channelType, chatId });
  }

  listChatInstances(): ChatInstance[] {
    return [...this.chatInstances];
  }

  /** Workspace template currently bound to (channel, chat). */
  workspaceForChat(channelType: ChannelType, chatId: string): Workspace | undefined {
    const inst = this.findChatInstance(channelType, chatId);
    if (!inst) return undefined;
    return this.byId.get(inst.workspaceId);
  }

  // ---- Active session + cost on the ChatInstance ---------------------------

  bindActiveSession(channelType: ChannelType, chatId: string, sdkSessionId: string): void {
    const inst = this.findChatInstance(channelType, chatId);
    if (!inst) throw new Error(`bindActiveSession: no chat instance for ${channelType}:${chatId}`);
    inst.activeSessionId = sdkSessionId;
    inst.lastActiveAt = new Date().toISOString();
    void this.save().catch(() => undefined);
  }

  clearActiveSession(channelType: ChannelType, chatId: string): void {
    const inst = this.findChatInstance(channelType, chatId);
    if (!inst) return;
    inst.activeSessionId = null;
    void this.save().catch(() => undefined);
  }

  getActiveSessionId(channelType: ChannelType, chatId: string): string | null {
    return this.findChatInstance(channelType, chatId)?.activeSessionId ?? null;
  }

  /**
   * Pass `sessionEnded=true` exactly once per session lifecycle (replace,
   * stop, IdleStop) so sessionCount stays accurate.
   */
  addCost(
    channelType: ChannelType,
    chatId: string,
    deltaUsd: number,
    sessionEnded: boolean,
  ): void {
    const inst = this.findChatInstance(channelType, chatId);
    if (!inst) return;
    inst.costRollup.totalUsd += deltaUsd;
    if (sessionEnded) inst.costRollup.sessionCount += 1;
    void this.save().catch(() => undefined);
  }

  // ---- lazyResumeOrCreate (spec §6.1) --------------------------------------

  private readonly lazyChain = new Map<string, Promise<unknown>>();

  /**
   * Plain-text IM flow. Three branches:
   *   (1) activeSessionId set + live → sendInput
   *   (2) activeSessionId set + !isLive + hasPersistedSession → resume + sendInput
   *   (3) else → createLocal with workspace defaults
   *
   * Per-chat serialized — concurrent calls for the same (channelType, chatId)
   * await each other rather than racing on activeSessionId reads.
   *
   * Throws if no binding exists for (channelType, chatId); callers should
   * pre-check via workspaceForChat and surface a friendlier "select workspace"
   * prompt instead of relying on this throw.
   */
  async lazyResumeOrCreate(
    channelType: ChannelType,
    chatId: string,
    text: string,
    source: 'im' | 'cli',
    deps: LazyResumeDeps,
  ): Promise<LazyResumeOutcome> {
    const inst = this.findChatInstance(channelType, chatId);
    if (!inst) {
      throw new Error(`lazyResumeOrCreate: chat ${channelType}:${chatId} not bound`);
    }
    const ws = this.byId.get(inst.workspaceId);
    if (!ws) {
      throw new Error(`lazyResumeOrCreate: workspace ${inst.workspaceId} for chat ${channelType}:${chatId} missing`);
    }
    const chainKey = `${channelType}:${chatId}`;
    const previous = this.lazyChain.get(chainKey) ?? Promise.resolve();
    const next = previous.then(async () => this.lazyInner(ws, inst, text, source, deps));
    this.lazyChain.set(chainKey, next.catch(() => undefined));
    return next;
  }

  private async lazyInner(
    workspace: Workspace,
    inst: ChatInstance,
    text: string,
    source: 'im' | 'cli',
    deps: LazyResumeDeps,
  ): Promise<LazyResumeOutcome> {
    const activeId = inst.activeSessionId;
    if (activeId) {
      if (deps.isLive(activeId)) {
        await deps.sendInput(activeId, text, source);
        deps.onBranch?.({ branch: 'live', sessionId: activeId, workspaceId: workspace.id });
        return { action: 'sent_to_live', session: { id: activeId, kind: 'local' } as SessionLike };
      }
      if (await deps.hasPersistedSession(activeId)) {
        let resumed: SessionLike | null = null;
        let err: Error | null = null;
        try { resumed = await deps.resume(activeId); }
        catch (e) { err = e instanceof Error ? e : new Error(String(e)); }
        if (resumed) {
          await deps.sendInput(resumed.id, text, source);
          inst.activeSessionId = resumed.id;
          inst.lastActiveAt = new Date().toISOString();
          void this.save().catch(() => undefined);
          deps.onBranch?.({ branch: 'resumed', sessionId: resumed.id, workspaceId: workspace.id });
          return { action: 'resumed', session: resumed };
        }
        deps.onResumeFailed?.({
          channelType: inst.channelType, chatId: inst.chatId,
          workspaceId: workspace.id, sdkSessionId: activeId,
          reason: err ? err.message : 'resume returned null',
        });
      }
      inst.activeSessionId = null;
    }

    const session = await deps.createLocal({
      workspaceId: workspace.id,
      provider: workspace.defaults.provider,
      workdir: workspace.workdir,
      initialPrompt: text,
      source,
    });
    inst.activeSessionId = session.id;
    inst.lastActiveAt = new Date().toISOString();
    void this.save().catch(() => undefined);
    deps.onBranch?.({ branch: 'created', sessionId: session.id, workspaceId: workspace.id });
    return { action: 'created', session };
  }

  // ---- Persistence (workspaces.json v2) ------------------------------------

  async save(): Promise<void> {
    if (!this.persistPath) return;
    const path = this.persistPath;
    await fs.mkdir(dirname(path), { recursive: true });
    const payload = {
      version: SCHEMA_VERSION,
      workspaces: [...this.byId.values()].map((ws) => ({ ...ws })),
      chatInstances: this.chatInstances.map((c) => ({ ...c })),
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
    const parsed = JSON.parse(raw) as {
      version?: number;
      workspaces?: Workspace[];
      chatInstances?: ChatInstance[];
    };
    if (parsed.version !== SCHEMA_VERSION) {
      throw new Error(
        `WorkspaceManager.load: schema version ${parsed.version ?? 'missing'} unsupported (expected ${SCHEMA_VERSION}). ` +
        `v1.0 is a breaking change — see docs/upgrade-v1.0.md and remove ~/.tlive/workspaces.json before relaunch.`,
      );
    }
    if (Array.isArray(parsed.workspaces)) {
      for (const ws of parsed.workspaces) {
        if (typeof ws.id === 'string' && typeof ws.name === 'string' && typeof ws.workdir === 'string') {
          this.byId.set(ws.id, { ...ws });
        }
      }
    }
    if (Array.isArray(parsed.chatInstances)) {
      this.chatInstances = parsed.chatInstances
        .filter((c) => typeof c.workspaceId === 'string' && typeof c.chatId === 'string')
        .map((c) => ({ ...c }));
    }
  }

  // ---- Convenience ---------------------------------------------------------

  ensureForWorkdir(workdir: string, provider: AgentProvider = 'claude'): Workspace {
    const existing = this.findByWorkdir(workdir);
    if (existing) return existing;
    const name = basename(workdir) || 'workspace';
    return this.create({ name, workdir, defaults: { provider } });
  }
}
