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

  // Per chat-level isolation (spec §3), the active session lives on each
  // ChatBinding rather than the Workspace. Translate the legacy
  // spec.activeSession?.id field (which used to seed ws.activeSessionId)
  // into a ChatBinding.activeSessionId on the (channelType, chatId) of
  // this fake context, so commands that look up via
  // getActiveSessionIdForChat see the same value.
  const seededActiveId = spec.activeSession?.id ?? null;
  const workspace: Workspace | null = spec.workspace === null ? null : {
    id: 'ws-00000000-00000000',
    name: 'test-ws',
    workdir: '/tmp/ws',
    defaults: {
      provider: 'claude',
      permissionMode: 'default',
      thinking: 'collapsed',
      verbose: false,
      prewarmCache: false,
      threadPerSession: false,
    },
    budget: {},
    mcpServers: {},
    roles: {},
    defaultRole: 'observer',
    bindings: [{ channelType, chatId, activeSessionId: seededActiveId }],
    createdAt: new Date().toISOString(),
    ...(spec.workspace as Partial<Workspace>),
  } as Workspace;

  // Build a unified list of all workspaces (primary + otherWorkspaces).
  // findByChat / get / getRole / addBinding all operate on this list so that
  // multi-workspace tests (e.g. /bind from an unbound chat) work correctly.
  const defaultWorkspaceShape: Omit<Workspace, 'id' | 'name' | 'workdir' | 'roles' | 'bindings'> = {
    defaults: {
      provider: 'claude',
      permissionMode: 'default',
      thinking: 'collapsed',
      verbose: false,
      prewarmCache: false,
      threadPerSession: false,
    } as never,
    budget: {},
    mcpServers: {},
    defaultRole: 'observer',
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
      roles: {},
      bindings: [],
      ...(o as Partial<Workspace>),
    } as Workspace);
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
          // Default ownerChat to the inbound (channelType, chatId) so existing
          // tests that don't set ownerChat still pass the per-chat filter.
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
    findByChat(ct: ChannelType, cid: string) {
      workspaceCalls.push({ method: 'findByChat', args: [ct, cid] });
      return allWorkspaces.find((w) =>
        w.bindings.some((b) => b.channelType === ct && b.chatId === cid),
      );
    },
    list() { workspaceCalls.push({ method: 'list', args: [] }); return [...allWorkspaces]; },
    get(id: string) { workspaceCalls.push({ method: 'get', args: [id] }); return allWorkspaces.find((w) => w.id === id); },
    getRole(wsId: string, u: string) {
      workspaceCalls.push({ method: 'getRole', args: [wsId, u] });
      const found = allWorkspaces.find((w) => w.id === wsId);
      if (!found) return 'observer';
      return found.roles[u] ?? found.defaultRole ?? 'observer';
    },
    setRole(wsId: string, u: string, role: string) {
      workspaceCalls.push({ method: 'setRole', args: [wsId, u, role] });
      const found = allWorkspaces.find((w) => w.id === wsId);
      if (found) found.roles[u] = role as never;
    },
    addBinding(wsId: string, b: ChatBinding) {
      workspaceCalls.push({ method: 'addBinding', args: [wsId, b] });
      const found = allWorkspaces.find((w) => w.id === wsId);
      if (found) found.bindings.push(b);
      return found;
    },
    removeBinding(wsId: string, key: unknown) {
      workspaceCalls.push({ method: 'removeBinding', args: [wsId, key] });
      return allWorkspaces.find((w) => w.id === wsId);
    },
    bindActiveSessionForChat(ct: ChannelType, cid: string, sid: string) {
      workspaceCalls.push({ method: 'bindActiveSessionForChat', args: [ct, cid, sid] });
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
    clearActiveSessionForChat(ct: ChannelType, cid: string) {
      workspaceCalls.push({ method: 'clearActiveSessionForChat', args: [ct, cid] });
      for (const w of allWorkspaces) {
        const b = w.bindings.find((x) => x.channelType === ct && x.chatId === cid);
        if (b) { b.activeSessionId = null; return; }
      }
    },
    getActiveSessionIdForChat(ct: ChannelType, cid: string) {
      workspaceCalls.push({ method: 'getActiveSessionIdForChat', args: [ct, cid] });
      for (const w of allWorkspaces) {
        const b = w.bindings.find((x) => x.channelType === ct && x.chatId === cid);
        if (b) return b.activeSessionId ?? null;
      }
      return null;
    },
    listActiveBindings() {
      workspaceCalls.push({ method: 'listActiveBindings', args: [] });
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
    listBindings(wsId: string) {
      workspaceCalls.push({ method: 'listBindings', args: [wsId] });
      return allWorkspaces.find((w) => w.id === wsId)?.bindings ?? [];
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
