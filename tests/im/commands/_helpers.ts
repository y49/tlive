// tests/im/commands/_helpers.ts
//
// Shared helpers for command unit tests. Builds a CommandContext with
// fake SessionManager / WorkspaceManager / brokers so each command test
// can focus on assertion rather than plumbing.

import type { CommandContext } from '../../../src/im/command-parser.js';
import type { InboundEvent, ReplyMarkup } from '../../../src/platform/types.js';
import type { SessionManager } from '../../../src/session/manager.js';
import type { WorkspaceManager } from '../../../src/workspace/manager.js';
import type { PermissionBroker } from '../../../src/permission/broker.js';
import type { AskUserQuestionBroker } from '../../../src/permission/ask-broker.js';
import type { ElicitationBroker } from '../../../src/permission/elicitation-broker.js';
import type { Workspace } from '../../../src/workspace/config.js';
import type { ChatInstance } from '../../../src/workspace/chat-instance.js';
import type { LocalSession } from '../../../src/session/local-session.js';
import type { ChannelType } from '../../../src/workspace/chat-instance.js';
import type { PolicyStore } from '../../../src/permission/policy-store.js';
import type { Logger, LogLevel } from '../../../src/util/logger.js';

export interface CapturedLog {
  level: LogLevel;
  msg: string;
  fields?: Record<string, unknown>;
}

export interface FakeCtxSpec {
  workspace?: Partial<Workspace> | null;
  /** Workspaces visible via workspaceManager.list() that are NOT bound to
   *  the current chat. Useful for testing /bind from an unbound chat. */
  otherWorkspaces?: Array<Partial<Workspace>>;
  activeSession?: Partial<LocalSession> | null;
  sessions?: Array<Partial<LocalSession>>;
  channelType?: ChannelType;
  chatId?: string;
  userId?: string;
  username?: string;
  /** Optional policy store provider for /perm tests. */
  policyStoreFor?: (workspaceId: string) => PolicyStore | undefined;
  /** Pass `true` to install a capturing logger fake; logs surface via FakeCtxResult.logs. */
  withLogger?: boolean;
}

export interface FakeCtxResult {
  ctx: CommandContext;
  replies: string[];
  /** Parallel to `replies`: the replyMarkup arg (if any) for each reply. */
  replyMarkups: Array<ReplyMarkup | undefined>;
  sessionCalls: Array<{ method: string; args: unknown[] }>;
  workspaceCalls: Array<{ method: string; args: unknown[] }>;
  brokerCalls: Array<{ method: string; args: unknown[] }>;
  /** The primary workspace bound to this chat (null when spec.workspace=null). */
  ws: Workspace | null;
  /** Captured logger output when spec.withLogger=true; otherwise empty. */
  logs: CapturedLog[];
}

export function buildCtx(spec: FakeCtxSpec = {}): FakeCtxResult {
  const replies: string[] = [];
  const replyMarkups: Array<ReplyMarkup | undefined> = [];
  const sessionCalls: Array<{ method: string; args: unknown[] }> = [];
  const workspaceCalls: Array<{ method: string; args: unknown[] }> = [];
  const brokerCalls: Array<{ method: string; args: unknown[] }> = [];

  const channelType: ChannelType = spec.channelType ?? 'telegram';
  const chatId = spec.chatId ?? '12345';
  const userId = spec.userId ?? 'u1';
  const username = spec.username ?? 'tester';

  // seededActiveId: from spec.workspace.activeSessionId (legacy field accepted for compat)
  // or spec.activeSession.id
  const wsAny = spec.workspace as Record<string, unknown> | null | undefined;
  const seededActiveId: string | null =
    (wsAny?.['activeSessionId'] as string | undefined) ??
    spec.activeSession?.id ??
    null;

  const workspace: Workspace | null = spec.workspace === null ? null : {
    id: 'ws-00000000-00000000',
    name: 'test-ws',
    workdir: '/tmp/ws',
    defaults: {
      provider: 'claude',
      permissionMode: 'default',
      thinking: 'collapsed',
    },
    budget: {},
    mcpServers: {},
    createdAt: new Date().toISOString(),
    ...(spec.workspace as Partial<Workspace>),
  } as Workspace;

  const defaultWorkspaceShape: Omit<Workspace, 'id' | 'name' | 'workdir'> = {
    defaults: {
      provider: 'claude',
      permissionMode: 'default',
      thinking: 'collapsed',
    } as never,
    budget: {},
    mcpServers: {},
    createdAt: new Date().toISOString(),
  };
  const allWorkspaces: Workspace[] = [];
  if (workspace) allWorkspaces.push(workspace);
  for (const [i, o] of (spec.otherWorkspaces ?? []).entries()) {
    allWorkspaces.push({
      ...defaultWorkspaceShape,
      id: `ws-other-${i.toString().padStart(4, '0')}`,
      name: 'other',
      workdir: `/tmp/other-${i}`,
      ...(o as Partial<Workspace>),
    } as Workspace);
  }

  // Chat instances track the new per-chat state (activeSessionId, costRollup).
  // Seed one for the primary chat if workspace exists.
  const now = new Date().toISOString();
  const chatInstances: ChatInstance[] = [];
  if (workspace) {
    chatInstances.push({
      channelType,
      chatId,
      workspaceId: workspace.id,
      activeSessionId: seededActiveId,
      lastActiveAt: seededActiveId ? now : null,
      costRollup: { totalUsd: 0, sessionCount: 0, lastResetAt: now },
      createdAt: now,
    });
  }

  const activeSession = spec.activeSession
    ? ({
        kind: 'local',
        id: 'sess-0000-0000-0000-0000',
        shortAlias: 'abcd1234',
        workspaceId: workspace?.id ?? 'ws-00000000-00000000',
        ...(spec.activeSession as Partial<LocalSession>),
      } as unknown as LocalSession)
    : null;

  const allSessions = activeSession ? [activeSession] : [];
  if (spec.sessions) {
    for (const s of spec.sessions) {
      allSessions.push({
        kind: 'local',
        id: 'sess-aaaa-aaaa-aaaa-aaaa',
        shortAlias: 'aaaabbbb',
        workspaceId: workspace?.id ?? 'ws-00000000-00000000',
        ...s,
      } as unknown as LocalSession);
    }
  }

  const sessionManager = {
    get(id: string) {
      sessionCalls.push({ method: 'get', args: [id] });
      return allSessions.find((s) => s.id === id);
    },
    getByPrefix(prefix: string) {
      sessionCalls.push({ method: 'getByPrefix', args: [prefix] });
      const hits = allSessions.filter((s) =>
        s.shortAlias?.startsWith(prefix) || s.id.startsWith(prefix)
      );
      if (hits.length === 1) return { resolved: hits[0], ambiguous: [] };
      if (hits.length > 1) return { resolved: null, ambiguous: hits };
      return { resolved: null, ambiguous: [] };
    },
    async createLocal(opts: unknown) {
      sessionCalls.push({ method: 'createLocal', args: [opts] });
      return { id: 'new-sess-id', shortAlias: 'newabcd1', ...opts } as unknown as LocalSession;
    },
    async resumeLocal(id: string) {
      sessionCalls.push({ method: 'resumeLocal', args: [id] });
      return { id, shortAlias: id.slice(0, 8) } as unknown as LocalSession;
    },
    async stop(id: string) { sessionCalls.push({ method: 'stop', args: [id] }); },
    listInfo(kind?: string) {
      sessionCalls.push({ method: 'listInfo', args: [kind] });
      return allSessions.map((s) => {
        const ownerChat = (s as unknown as { ownerChat?: { channelType: ChannelType; chatId: string; threadId?: string } }).ownerChat
          ?? { channelType, chatId };
        return {
          id: s.id, shortAlias: s.shortAlias ?? '', kind: 'local' as const,
          provider: 'claude' as const, workspaceId: s.workspaceId ?? '',
          workdir: '/tmp', title: (s as unknown as { title?: string }).title,
          status: { phase: 'idle' as const, queuedInputs: 0 },
          cost: { totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          createdAt: Date.now(), lastActivityAt: Date.now(),
          ownerChat,
        };
      });
    },
    subscribe(_l: unknown) { return () => undefined; },
  } as unknown as SessionManager;

  const workspaceManager = {
    // New API
    workspaceForChat(ct: ChannelType, cid: string) {
      workspaceCalls.push({ method: 'workspaceForChat', args: [ct, cid] });
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (!inst) return undefined;
      return allWorkspaces.find((w) => w.id === inst.workspaceId);
    },
    list() { workspaceCalls.push({ method: 'list', args: [] }); return [...allWorkspaces]; },
    get(id: string) { workspaceCalls.push({ method: 'get', args: [id] }); return allWorkspaces.find((w) => w.id === id); },
    findByWorkdir(workdir: string) {
      workspaceCalls.push({ method: 'findByWorkdir', args: [workdir] });
      return allWorkspaces.find((w) => w.workdir === workdir);
    },
    bindChat(opts: { workspaceId: string; channelType: ChannelType; chatId: string; threadId?: string }) {
      workspaceCalls.push({ method: 'bindChat', args: [opts] });
      const t = new Date().toISOString();
      const inst: ChatInstance = {
        channelType: opts.channelType, chatId: opts.chatId, threadId: opts.threadId,
        workspaceId: opts.workspaceId,
        activeSessionId: null, lastActiveAt: null,
        costRollup: { totalUsd: 0, sessionCount: 0, lastResetAt: t },
        createdAt: t,
      };
      // Remove any existing before adding (allow rebind to same ws or new ws)
      const idx = chatInstances.findIndex((c) => c.channelType === opts.channelType && c.chatId === opts.chatId);
      if (idx >= 0) chatInstances.splice(idx, 1);
      chatInstances.push(inst);
      return inst;
    },
    unbindChat(ct: ChannelType, cid: string) {
      workspaceCalls.push({ method: 'unbindChat', args: [ct, cid] });
      const idx = chatInstances.findIndex((c) => c.channelType === ct && c.chatId === cid);
      if (idx >= 0) { const removed = chatInstances[idx]; chatInstances.splice(idx, 1); return removed; }
      return undefined;
    },
    switchChat(ct: ChannelType, cid: string, newWsId: string) {
      workspaceCalls.push({ method: 'switchChat', args: [ct, cid, newWsId] });
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (!inst) throw new Error(`switchChat: ${ct}:${cid} not bound`);
      inst.workspaceId = newWsId;
      inst.activeSessionId = null;
      inst.costRollup = { totalUsd: 0, sessionCount: 0, lastResetAt: new Date().toISOString() };
      return inst;
    },
    findChatInstance(ct: ChannelType, cid: string) {
      workspaceCalls.push({ method: 'findChatInstance', args: [ct, cid] });
      return chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
    },
    listChatInstances() {
      workspaceCalls.push({ method: 'listChatInstances', args: [] });
      return [...chatInstances];
    },
    bindActiveSession(ct: ChannelType, cid: string, sid: string) {
      workspaceCalls.push({ method: 'bindActiveSession', args: [ct, cid, sid] });
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (!inst) throw new Error(`bindActiveSession: no chat instance for ${ct}:${cid}`);
      inst.activeSessionId = sid;
      inst.lastActiveAt = new Date().toISOString();
    },
    clearActiveSession(ct: ChannelType, cid: string) {
      workspaceCalls.push({ method: 'clearActiveSession', args: [ct, cid] });
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (inst) inst.activeSessionId = null;
    },
    getActiveSessionId(ct: ChannelType, cid: string) {
      workspaceCalls.push({ method: 'getActiveSessionId', args: [ct, cid] });
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      return inst?.activeSessionId ?? null;
    },
    addCost(ct: ChannelType, cid: string, delta: number, ended: boolean) {
      workspaceCalls.push({ method: 'addCost', args: [ct, cid, delta, ended] });
      const inst = chatInstances.find((c) => c.channelType === ct && c.chatId === cid);
      if (inst) {
        inst.costRollup.totalUsd += delta;
        if (ended) inst.costRollup.sessionCount++;
      }
    },
    removeWorkspace(id: string, opts?: { force?: boolean }) {
      workspaceCalls.push({ method: 'removeWorkspace', args: [id, opts] });
      const idx = allWorkspaces.findIndex((w) => w.id === id);
      if (idx < 0) return { workspace: undefined, chatInstances: [] };
      const ws = allWorkspaces[idx]!;
      allWorkspaces.splice(idx, 1);
      const removed = chatInstances.filter((c) => c.workspaceId === id);
      chatInstances.splice(0, chatInstances.length, ...chatInstances.filter((c) => c.workspaceId !== id));
      return { workspace: ws, chatInstances: removed };
    },
    async save() { workspaceCalls.push({ method: 'save', args: [] }); },
  } as unknown as WorkspaceManager;

  const permissionBroker = {
    resolve(sid: string, rid: string, dec: unknown, uid?: string) {
      brokerCalls.push({ method: 'perm.resolve', args: [sid, rid, dec, uid] }); return true;
    },
    resolveById(rid: string, dec: unknown, uid?: string) {
      brokerCalls.push({ method: 'perm.resolveById', args: [rid, dec, uid] }); return true;
    },
    pendingFor(sid: string) { brokerCalls.push({ method: 'perm.pendingFor', args: [sid] }); return []; },
  } as unknown as PermissionBroker;

  const askBroker = {
    resolve(sid: string, rid: string, chosen: unknown, uid?: string) {
      brokerCalls.push({ method: 'ask.resolve', args: [sid, rid, chosen, uid] }); return true;
    },
    pendingFor(sid: string) { brokerCalls.push({ method: 'ask.pendingFor', args: [sid] }); return []; },
  } as unknown as AskUserQuestionBroker;

  const elicitationBroker = {
    resolve(sid: string, rid: string, res: unknown, uid?: string) {
      brokerCalls.push({ method: 'elic.resolve', args: [sid, rid, res, uid] }); return true;
    },
    pendingFor(sid: string) { brokerCalls.push({ method: 'elic.pendingFor', args: [sid] }); return []; },
  } as unknown as ElicitationBroker;

  const inbound: InboundEvent = {
    channelType, chatId, messageId: 'm1',
    userId, username, text: '', kind: 'message', at: Date.now(),
  };

  const logs: CapturedLog[] = [];
  const logger: Logger | undefined = spec.withLogger
    ? {
        level: 'debug',
        debug: (msg, fields) => { logs.push({ level: 'debug', msg, fields }); },
        info: (msg, fields) => { logs.push({ level: 'info', msg, fields }); },
        warn: (msg, fields) => { logs.push({ level: 'warn', msg, fields }); },
        error: (msg, fields) => { logs.push({ level: 'error', msg, fields }); },
        child: () => logger!,
      }
    : undefined;

  const ctx: CommandContext = {
    inbound,
    userId,
    sessionManager,
    workspaceManager,
    permissionBroker,
    askBroker,
    elicitationBroker,
    policyStoreFor: spec.policyStoreFor,
    async reply(text: string, opts?: { replyMarkup?: ReplyMarkup }) {
      replies.push(text);
      replyMarkups.push(opts?.replyMarkup);
    },
    logger,
  };

  return { ctx, replies, replyMarkups, sessionCalls, workspaceCalls, brokerCalls, ws: workspace, logs };
}
