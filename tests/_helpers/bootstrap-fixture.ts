// tests/_helpers/bootstrap-fixture.ts
//
// Reusable e2e fixture for IM command + callback tests.
//
// Provides a minimal environment that wires the real command registry
// (dispatch) and the real CallbackRouter without spinning up the full daemon:
//   - handleInbound(ev) — dispatches a text/command inbound event using the
//     real dispatch() from command-parser.ts. Role is resolved from the
//     workspace's roles map (or defaultRole), mirroring bootstrap.handleInbound.
//   - dispatchCallback(ev) — routes a callback event through the real
//     CallbackRouter.route(), with adapters wired for sendReply.
//   - adapter — FakeAdapter (telegram) that captures all outbound calls.
//   - workspaceManager — fake WM whose state is mutated by command calls.
//   - sessionManager — fake SM that records createLocal / stop calls.
//   - cleanup() — no-op (no async resources in this fixture).
//
// Design notes:
//   - The fake WorkspaceManager and SessionManager follow the same shape as
//     tests/im/commands/_helpers.ts but exposed at a higher level (dispatch-
//     entry, not cmd.run) so role gating + registry dispatch are exercised.
//   - The fake SessionManager's createLocal returns a minimal SessionLike so
//     commands that call bindActiveSessionForChat can proceed normally.
//   - The fixture keeps deps minimal: only what /new, /sessions, /workspace
//     and their callbacks need for Tasks 9-14. Future tasks add fields as
//     needed; no fields are pre-anticipated.

import type { InboundEvent, ReplyMarkup } from '../../src/platform/types.js';
import type { SessionManager } from '../../src/session/manager.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import type { PermissionBroker } from '../../src/permission/broker.js';
import type { AskUserQuestionBroker } from '../../src/permission/ask-broker.js';
import type { ElicitationBroker } from '../../src/permission/elicitation-broker.js';
import type { LocalSession } from '../../src/session/local-session.js';
import type { ChatBinding, ChannelType } from '../../src/workspace/bindings.js';
import type { Workspace } from '../../src/workspace/config.js';
import type { Role } from '../../src/workspace/config.js';
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
  roles?: Record<string, Role>;
  defaultRole?: Role;
  bindings: Array<{
    channelType: 'telegram' | 'feishu';
    chatId: string;
    activeSessionId?: string | null;
  }>;
  defaults?: { model?: string; provider?: string };
}

export interface BootstrapFixtureOpts {
  workspaces: BootstrapWorkspaceSpec[];
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
    roles: { ...(s.roles ?? {}) },
    defaultRole: s.defaultRole ?? 'observer',
    defaults: {
      provider: (s.defaults?.provider ?? 'claude') as 'claude' | 'codex',
      model: s.defaults?.model,
      permissionMode: 'default',
      thinking: 'collapsed',
      verbose: false,
      prewarmCache: false,
      threadPerSession: false,
    },
    budget: {},
    mcpServers: {},
    bindings: s.bindings.map((b) => ({
      channelType: b.channelType,
      chatId: b.chatId,
      activeSessionId: b.activeSessionId ?? null,
    } as ChatBinding)),
    createdAt: new Date().toISOString(),
  }));

  const wm = {
    list(): Workspace[] { return [...allWorkspaces]; },
    get(id: string): Workspace | undefined {
      return allWorkspaces.find((w) => w.id === id);
    },
    findByChat(ct: ChannelType, cid: string): Workspace | undefined {
      return allWorkspaces.find((w) =>
        w.bindings.some((b) => b.channelType === ct && b.chatId === cid),
      );
    },
    getRole(wsId: string, userId: string): Role {
      const ws = allWorkspaces.find((w) => w.id === wsId);
      if (!ws) return 'observer';
      return (ws.roles[userId] as Role | undefined) ?? ws.defaultRole;
    },
    setRole(wsId: string, userId: string, role: Role): void {
      const ws = allWorkspaces.find((w) => w.id === wsId);
      if (ws) ws.roles[userId] = role;
    },
    claimAdmin(wsId: string, userId: string): boolean {
      const ws = allWorkspaces.find((w) => w.id === wsId);
      if (!ws) throw new Error(`claimAdmin: workspace ${wsId} not found`);
      const hasAdmin = Object.values(ws.roles).some((r) => r === 'admin');
      if (hasAdmin) return false;
      ws.roles[userId] = 'admin';
      return true;
    },
    addBinding(wsId: string, binding: ChatBinding): Workspace | undefined {
      const ws = allWorkspaces.find((w) => w.id === wsId);
      if (!ws) throw new Error(`addBinding: workspace ${wsId} not found`);
      ws.bindings.push(binding);
      return ws;
    },
    removeBinding(wsId: string, key: unknown): Workspace | undefined {
      return allWorkspaces.find((w) => w.id === wsId);
    },
    getActiveSessionIdForChat(ct: ChannelType, cid: string): string | null {
      for (const w of allWorkspaces) {
        const b = w.bindings.find((x) => x.channelType === ct && x.chatId === cid);
        if (b) return b.activeSessionId ?? null;
      }
      return null;
    },
    bindActiveSessionForChat(ct: ChannelType, cid: string, sid: string): void {
      for (const w of allWorkspaces) {
        const b = w.bindings.find((x) => x.channelType === ct && x.chatId === cid);
        if (b) {
          b.activeSessionId = sid;
          b.lastActiveAt = new Date().toISOString();
          return;
        }
      }
      throw new Error(`bindActiveSessionForChat: no binding for ${ct}:${cid}`);
    },
    clearActiveSessionForChat(ct: ChannelType, cid: string): void {
      for (const w of allWorkspaces) {
        const b = w.bindings.find((x) => x.channelType === ct && x.chatId === cid);
        if (b) { b.activeSessionId = null; return; }
      }
    },
    listActiveBindings(): Array<{
      channelType: ChannelType; chatId: string; workspaceId: string;
      activeSessionId: string; lastActiveAt: string;
    }> {
      const out: Array<{
        channelType: ChannelType; chatId: string; workspaceId: string;
        activeSessionId: string; lastActiveAt: string;
      }> = [];
      for (const w of allWorkspaces) {
        for (const b of w.bindings) {
          if (!b.activeSessionId) continue;
          out.push({
            channelType: b.channelType, chatId: b.chatId, workspaceId: w.id,
            activeSessionId: b.activeSessionId,
            lastActiveAt: b.lastActiveAt ?? new Date(0).toISOString(),
          });
        }
      }
      return out;
    },
    listBindings(wsId: string): ChatBinding[] {
      return allWorkspaces.find((w) => w.id === wsId)?.bindings ?? [];
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
      const s = {
        kind: 'local', id, shortAlias: alias, workspaceId: opts.workspaceId, ...opts,
        // Stub setModel / getModel so callback tests can call runtime:model:set:*.
        async setModel(m: string) { _model = m; },
        get sdkModel() { return _model; },
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
// Main factory
// --------------------------------------------------------------------------

export function setupBootstrap(opts: BootstrapFixtureOpts): BootstrapFixture {
  // Register commands (idempotent-ish via reset first).
  resetRegistryForTests();
  registerAllCommands();

  const adapter = new FakeAdapter('telegram');
  const replies: string[] = [];

  // Intercept send to capture reply text.
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

  // Build real CallbackRouter with adapters wired so sendReply works.
  const adaptersRecord: Partial<Record<ChannelType, typeof adapter>> = { telegram: adapter };
  const callbackRouter = new CallbackRouter({
    sessionManager,
    permissionBroker,
    askBroker,
    elicitationBroker,
    adapters: adaptersRecord,
    workspaceManager,
  });

  async function handleInbound(spec: InboundSpec): Promise<void> {
    const { channelType, chatId, userId, text, messageId } = spec;

    // Resolve role from workspace (mirrors bootstrap.handleInbound).
    const ws = workspaceManager.findByChat(channelType, chatId);
    const role = ws ? userRole(ws, userId) : 'observer';

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
        reply: replyFn,
      },
      text,
      role,
    );
  }

  async function dispatchCallback(spec: CallbackSpec): Promise<void> {
    const { channelType, chatId, userId, messageId, callbackData } = spec;
    // Map-form adapters for CallbackContext (distinct from record-form deps.adapters).
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
