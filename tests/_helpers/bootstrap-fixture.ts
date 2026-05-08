// tests/_helpers/bootstrap-fixture.ts
//
// Reusable e2e fixture for IM command + callback tests.
//
// Provides a minimal environment that wires the real command registry
// (dispatch) and the real CallbackRouter without spinning up the full daemon:
//   - handleInbound(ev) — dispatches a text/command inbound event using the
//     real dispatch() from command-parser.ts.
//   - dispatchCallback(ev) — routes a callback event through the real
//     CallbackRouter.route(), with adapters wired for sendReply.
//   - adapter — FakeAdapter (telegram) that captures all outbound calls.
//   - workspaceManager — fake WM whose state is mutated by command calls.
//   - sessionManager — fake SM that records createLocal / stop calls.
//   - cleanup() — no-op (no async resources in this fixture).
//
// Design notes:
//   - v1.0 chat-trust model: no roles/admins. All chat users can drive the bot.
//     The fake WM uses the new ChatInstance API (bindChat/workspaceForChat/etc).
//   - The fixture keeps deps minimal: only what /new, /sessions, /workspace
//     and their callbacks need. Future tasks add fields as needed.

import type { InboundEvent, ReplyMarkup } from '../../src/platform/types.js';
import type { SessionManager } from '../../src/session/manager.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import type { PermissionBroker } from '../../src/permission/broker.js';
import type { AskUserQuestionBroker } from '../../src/permission/ask-broker.js';
import type { ElicitationBroker } from '../../src/permission/elicitation-broker.js';
import type { LocalSession } from '../../src/session/local-session.js';
import type { ChannelType } from '../../src/workspace/chat-instance.js';
import type { ChatInstance } from '../../src/workspace/chat-instance.js';
import type { Workspace } from '../../src/workspace/config.js';
import type { Role } from '../../src/workspace/config.js';
import type { PermissionMode } from '../../src/runtime/types.js';
import type { PolicyStore, PolicyRule } from '../../src/permission/policy-store.js';
import { dispatch, resetRegistryForTests } from '../../src/im/command-parser.js';
import { registerAllCommands } from '../../src/im/commands/index.js';
import { CallbackRouter } from '../../src/im/callback-router.js';
import { userRole } from '../../src/im/commands/_shared.js';
import { FakeAdapter } from '../im/fake-adapter.js';

// --------------------------------------------------------------------------
// Public opts shape
// --------------------------------------------------------------------------

export interface BootstrapWorkspaceSpec {
  id: string;
  name: string;
  workdir: string;
  /** T3-PENDING: roles removed in chat-trust; accepted here for backward compat
   *  with existing tests until T3 cleans them up. */
  roles?: Record<string, Role>;
  defaultRole?: Role;
  bindings: Array<{
    channelType: 'telegram' | 'feishu';
    chatId: string;
    activeSessionId?: string | null;
  }>;
  defaults?: { model?: string; provider?: string; permissionMode?: string };
}

export interface BootstrapFixtureOpts {
  workspaces: BootstrapWorkspaceSpec[];
  /**
   * Optional fake PolicyStore factory for /perm tests. When provided, it is
   * wired into both the CommandContext (policyStoreFor) and the CallbackRouter
   * deps (policyStoreFor) so both the command and callback paths can manage
   * policy rules without touching the filesystem.
   */
  policyStoreFor?: (workspaceId: string) => PolicyStore;
}

// --------------------------------------------------------------------------
// Return shape
// --------------------------------------------------------------------------

export interface InboundSpec {
  channelType: ChannelType;
  chatId: string;
  userId: string;
  text: string;
  messageId?: string;
}

export interface CallbackSpec {
  channelType: ChannelType;
  chatId: string;
  userId: string;
  messageId?: string;
  callbackData: string;
}

export interface BootstrapFixture {
  handleInbound(spec: InboundSpec): Promise<void>;
  dispatchCallback(spec: CallbackSpec): Promise<void>;
  adapter: FakeAdapter;
  workspaceManager: WorkspaceManager;
  sessionManager: SessionManager;
  /** All text replies sent via adapter.send() (extracted for convenience). */
  replies: string[];
  cleanup?(): Promise<void>;
}

// --------------------------------------------------------------------------
// Fake workspace manager (stateful — mutations visible to callers)
// --------------------------------------------------------------------------

function buildFakeWorkspaceManager(specs: BootstrapWorkspaceSpec[]): WorkspaceManager {
  const allWorkspaces: Workspace[] = specs.map((s) => ({
    id: s.id,
    name: s.name,
    workdir: s.workdir,
    defaults: {
      provider: (s.defaults?.provider ?? 'claude') as 'claude' | 'codex',
      model: s.defaults?.model,
      permissionMode: (s.defaults?.permissionMode ?? 'default') as PermissionMode,
      thinking: 'collapsed',
    },
    budget: {},
    mcpServers: {},
    createdAt: new Date().toISOString(),
    // T3-PENDING: stash roles for backward compat (existing tests read them via userRole)
    _roles: { ...(s.roles ?? {}) } as Record<string, Role>,
    _defaultRole: (s.defaultRole ?? 'observer') as Role,
  } as unknown as Workspace));

  // Seed ChatInstances from bindings spec
  const now = new Date().toISOString();
  const chatInstances: ChatInstance[] = [];
  for (const s of specs) {
    for (const b of s.bindings) {
      chatInstances.push({
        channelType: b.channelType as ChannelType,
        chatId: b.chatId,
        workspaceId: s.id,
        activeSessionId: b.activeSessionId ?? null,
        lastActiveAt: b.activeSessionId ? now : null,
        costRollup: { totalUsd: 0, sessionCount: 0, lastResetAt: now },
        createdAt: now,
      });
    }
  }

  const wm = {
    list(): Workspace[] { return [...allWorkspaces]; },
    get(id: string): Workspace | undefined {
      return allWorkspaces.find((w) => w.id === id);
    },
    findByWorkdir(workdir: string): Workspace | undefined {
      return allWorkspaces.find((w) => w.workdir === workdir);
    },
    // New API
    workspaceForChat(ct: ChannelType, cid: string): Workspace | undefined {
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (!inst) return undefined;
      return allWorkspaces.find((w) => w.id === inst.workspaceId);
    },
    findChatInstance(ct: ChannelType, cid: string): ChatInstance | undefined {
      return chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
    },
    listChatInstances(): ChatInstance[] {
      return [...chatInstances];
    },
    bindChat(opts: { workspaceId: string; channelType: ChannelType; chatId: string; threadId?: string }): ChatInstance {
      const t = new Date().toISOString();
      const inst: ChatInstance = {
        channelType: opts.channelType, chatId: opts.chatId, threadId: opts.threadId,
        workspaceId: opts.workspaceId,
        activeSessionId: null, lastActiveAt: null,
        costRollup: { totalUsd: 0, sessionCount: 0, lastResetAt: t },
        createdAt: t,
      };
      const idx = chatInstances.findIndex((c) => c.channelType === opts.channelType && c.chatId === opts.chatId);
      if (idx >= 0) chatInstances.splice(idx, 1);
      chatInstances.push(inst);
      return inst;
    },
    unbindChat(ct: ChannelType, cid: string): ChatInstance | undefined {
      const idx = chatInstances.findIndex((c) => c.channelType === ct && c.chatId === cid);
      if (idx >= 0) { const r = chatInstances[idx]!; chatInstances.splice(idx, 1); return r; }
      return undefined;
    },
    switchChat(ct: ChannelType, cid: string, newWsId: string): ChatInstance {
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (!inst) throw new Error(`switchChat: ${ct}:${cid} not bound`);
      inst.workspaceId = newWsId;
      inst.activeSessionId = null;
      inst.costRollup = { totalUsd: 0, sessionCount: 0, lastResetAt: new Date().toISOString() };
      return inst;
    },
    getActiveSessionId(ct: ChannelType, cid: string): string | null {
      return chatInstances.find((c) => c.channelType === ct && c.chatId === cid)?.activeSessionId ?? null;
    },
    bindActiveSession(ct: ChannelType, cid: string, sid: string): void {
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (!inst) throw new Error(`bindActiveSession: no binding for ${ct}:${cid}`);
      inst.activeSessionId = sid;
      inst.lastActiveAt = new Date().toISOString();
    },
    clearActiveSession(ct: ChannelType, cid: string): void {
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (inst) inst.activeSessionId = null;
    },
    addCost(ct: ChannelType, cid: string, delta: number, ended: boolean): void {
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (inst) {
        inst.costRollup.totalUsd += delta;
        if (ended) inst.costRollup.sessionCount++;
      }
    },
    removeWorkspace(id: string, opts?: { force?: boolean }) {
      const idx = allWorkspaces.findIndex((w) => w.id === id);
      if (idx < 0) return { workspace: undefined, chatInstances: [] };
      const bound = chatInstances.filter((c) => c.workspaceId === id);
      if (bound.length > 0 && !opts?.force) throw new Error(`removeWorkspace: ${bound.length} chat(s) still bound`);
      const ws = allWorkspaces[idx]!;
      allWorkspaces.splice(idx, 1);
      const removed = chatInstances.filter((c) => c.workspaceId === id);
      chatInstances.splice(0, chatInstances.length, ...chatInstances.filter((c) => c.workspaceId !== id));
      return { workspace: ws, chatInstances: removed };
    },
    // T3-PENDING: role methods below will be removed in T3
    getRole(wsId: string, userId: string): Role {
      const ws = allWorkspaces.find((w) => w.id === wsId) as unknown as { _roles?: Record<string, Role>; _defaultRole?: Role } | undefined;
      if (!ws) return 'observer';
      return (ws._roles?.[userId] as Role | undefined) ?? (ws._defaultRole ?? 'observer');
    },
    setRole(wsId: string, userId: string, role: Role): void {
      const ws = allWorkspaces.find((w) => w.id === wsId) as unknown as { _roles?: Record<string, Role> } | undefined;
      if (ws?._roles) ws._roles[userId] = role;
    },
    claimAdmin(wsId: string, userId: string): boolean {
      const ws = allWorkspaces.find((w) => w.id === wsId) as unknown as { _roles?: Record<string, Role> } | undefined;
      if (!ws) throw new Error(`claimAdmin: workspace ${wsId} not found`);
      const roles = ws._roles ?? {};
      if (Object.values(roles).some((r) => r === 'admin')) return false;
      if (!ws._roles) (ws as unknown as Record<string, unknown>)['_roles'] = {};
      (ws as unknown as { _roles: Record<string, Role> })._roles[userId] = 'admin';
      return true;
    },
    async save(): Promise<void> { /* no-op */ },
  } as unknown as WorkspaceManager;

  return wm;
}

// --------------------------------------------------------------------------
// Fake session manager (minimal — records createLocal, stop)
// --------------------------------------------------------------------------

function buildFakeSessionManager(): SessionManager & {
  createLocalCalls: Array<Record<string, unknown>>;
  stopCalls: string[];
} {
  let counter = 0;
  const liveSessions = new Map<string, LocalSession>();
  const createLocalCalls: Array<Record<string, unknown>> = [];
  const stopCalls: string[] = [];

  const sm = {
    createLocalCalls,
    stopCalls,
    get(id: string): LocalSession | undefined { return liveSessions.get(id); },
    getByPrefix(prefix: string): { resolved: LocalSession | null; ambiguous: LocalSession[] } {
      const hits: LocalSession[] = [];
      for (const [id, s] of liveSessions) {
        if (id.startsWith(prefix) || (s.shortAlias ?? '').startsWith(prefix)) hits.push(s);
      }
      if (hits.length === 1) return { resolved: hits[0]!, ambiguous: [] };
      if (hits.length > 1) return { resolved: null, ambiguous: hits };
      return { resolved: null, ambiguous: [] };
    },
    async createLocal(opts: Record<string, unknown>): Promise<LocalSession> {
      createLocalCalls.push(opts);
      const id = `sess-fake-${++counter}`;
      const alias = id.replace(/[^a-z0-9]/g, '').slice(0, 8);
      let _model: string | undefined = opts.model as string | undefined;
      let _permissionMode: string = (opts.permissionMode as string | undefined) ?? 'default';
      let _budgetCap: number | undefined = undefined;
      const s = {
        kind: 'local', id, shortAlias: alias, workspaceId: opts.workspaceId, ...opts,
        async setModel(m: string) { _model = m; },
        get sdkModel() { return _model; },
        async setPermissionMode(m: string) { _permissionMode = m; },
        get permissionMode() { return _permissionMode as PermissionMode; },
        setMaxBudget(usd: number | undefined) { _budgetCap = usd; },
        getMaxBudget() { return _budgetCap; },
        cost: { totalCost: 0 },
      } as unknown as LocalSession;
      liveSessions.set(id, s);
      return s;
    },
    async resumeLocal(id: string): Promise<LocalSession | null> { return liveSessions.get(id) ?? null; },
    async stop(id: string): Promise<void> { stopCalls.push(id); liveSessions.delete(id); },
    async stopAll(): Promise<void> { liveSessions.clear(); },
    listInfo(_kind?: 'local' | 'remote') {
      const out = [];
      for (const s of liveSessions.values()) {
        const rec = s as unknown as Record<string, unknown>;
        out.push({
          id: rec.id as string,
          shortAlias: rec.shortAlias as string,
          kind: 'local' as const,
          provider: (rec.provider as string | undefined) ?? 'claude',
          workspaceId: rec.workspaceId as string,
          workdir: (rec.workdir as string | undefined) ?? '/tmp',
          title: rec.title as string | undefined,
          status: { phase: 'idle' as const, queuedInputs: 0 },
          cost: { totalCost: 0, inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheCreationTokens: 0 },
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          ownerChat: rec.ownerChat as { channelType: string; chatId: string } | undefined,
        });
      }
      return out;
    },
    subscribe(_l: unknown) { return () => undefined; },
  } as unknown as SessionManager & { createLocalCalls: Array<Record<string, unknown>>; stopCalls: string[] };

  return sm;
}

// --------------------------------------------------------------------------
// Fake in-memory PolicyStore (for /perm tests — no filesystem I/O)
// --------------------------------------------------------------------------

export function buildFakePolicyStoreFactory(): {
  factory: (workspaceId: string) => PolicyStore;
  storeMap: Map<string, PolicyRule[]>;
} {
  const storeMap = new Map<string, PolicyRule[]>();
  let ruleCounter = 0;

  function getOrCreate(wsId: string): PolicyRule[] {
    if (!storeMap.has(wsId)) storeMap.set(wsId, []);
    return storeMap.get(wsId)!;
  }

  function factory(wsId: string): PolicyStore {
    const rules = getOrCreate(wsId);
    return {
      list(): PolicyRule[] { return [...rules]; },
      async add(
        pattern: PolicyRule['pattern'],
        decision: PolicyRule['decision'],
        scope: PolicyRule['scope'],
        createdBy: string,
      ): Promise<PolicyRule> {
        const rule: PolicyRule = {
          id: `pol-fake-${++ruleCounter}`,
          pattern, decision, scope, createdBy,
          createdAt: new Date().toISOString(),
        };
        rules.push(rule);
        return rule;
      },
      async remove(id: string): Promise<boolean> {
        const idx = rules.findIndex((r) => r.id === id);
        if (idx === -1) return false;
        rules.splice(idx, 1);
        return true;
      },
      match() { return null; },
      async load() { /* no-op */ },
      async save() { /* no-op */ },
    } as unknown as PolicyStore;
  }

  return { factory, storeMap };
}

// --------------------------------------------------------------------------
// Main factory
// --------------------------------------------------------------------------

export function setupBootstrap(opts: BootstrapFixtureOpts): BootstrapFixture {
  resetRegistryForTests();
  registerAllCommands();

  const adapter = new FakeAdapter('telegram');
  const replies: string[] = [];

  const originalSend = adapter.send.bind(adapter);
  adapter.send = async (msg) => {
    if (typeof msg.text === 'string') replies.push(msg.text);
    return originalSend(msg);
  };

  const workspaceManager = buildFakeWorkspaceManager(opts.workspaces);
  const sessionManager = buildFakeSessionManager();

  const permissionBroker = {
    resolve() { return true; },
    resolveById() { return true; },
    pendingFor() { return []; },
  } as unknown as PermissionBroker;

  const askBroker = {
    resolve() { return true; },
    pendingFor() { return []; },
  } as unknown as AskUserQuestionBroker;

  const elicitationBroker = {
    resolve() { return true; },
    pendingFor() { return []; },
  } as unknown as ElicitationBroker;

  const adaptersRecord: Partial<Record<ChannelType, typeof adapter>> = { telegram: adapter };
  const callbackRouter = new CallbackRouter({
    sessionManager,
    permissionBroker,
    askBroker,
    elicitationBroker,
    adapters: adaptersRecord,
    workspaceManager,
    ...(opts.policyStoreFor ? { policyStoreFor: opts.policyStoreFor } : {}),
  });

  async function handleInbound(spec: InboundSpec): Promise<void> {
    const { channelType, chatId, userId, text, messageId } = spec;

    // Resolve role from workspace (T3-PENDING: mirrors bootstrap.handleInbound role check).
    const ws = workspaceManager.workspaceForChat(channelType, chatId);
    const role = ws ? userRole(ws as unknown as { roles?: Record<string, string>; defaultRole?: string }, userId) : 'observer';

    const inbound: InboundEvent = {
      kind: 'message',
      channelType,
      chatId,
      userId,
      username: userId,
      messageId: messageId ?? 'm0',
      text,
      at: Date.now(),
    };

    const replyFn = async (t: string, _opts?: { replyMarkup?: ReplyMarkup }): Promise<void> => {
      replies.push(t);
      await adapter.send({ chatId, text: t, replyMarkup: _opts?.replyMarkup });
    };

    await dispatch(
      {
        inbound,
        userId,
        sessionManager,
        workspaceManager,
        permissionBroker,
        askBroker,
        elicitationBroker,
        ...(opts.policyStoreFor ? { policyStoreFor: opts.policyStoreFor } : {}),
        reply: replyFn,
      },
      text,
      role,
    );
  }

  async function dispatchCallback(spec: CallbackSpec): Promise<void> {
    const { channelType, chatId, userId, messageId, callbackData } = spec;
    const adapterMap = new Map<ChannelType, typeof adapter>([['telegram', adapter]]);
    await callbackRouter.route({
      data: callbackData,
      userId,
      chatId,
      messageId,
      channelType,
      adapters: adapterMap,
    });
  }

  return {
    handleInbound,
    dispatchCallback,
    adapter,
    workspaceManager,
    sessionManager,
    replies,
    async cleanup() {
      resetRegistryForTests();
    },
  };
}
