// tests/integration/onboarding.test.ts
//
// Per spec §7 — full onboarding e2e: empty WorkspaceManager → /workspace
// renders state B (empty) with [➕ 新增工作区] → user clicks → broker pending
// → user types absolute path → tryCreateWorkspaceFromPath validates fs.stat
// + findByWorkdir + calls create() + bindChat() → workspace bound to chat → /new can spawn a session.
//
// Real WorkspaceManager + CallbackRouter + WorkspaceCreateBroker +
// SessionManager driven by FakeRuntime via runtimeFactory; no real
// Claude/Codex SDK is spawned. Persistence + workspace files live under a
// real mkdtemp directory so fs probes (stat / hasSnapshot) exercise the
// production path.
//
// Three cases:
//   1. Happy path T0-T11: empty → /workspace → callback → path → /new.
//   2. /cancel mid-flow (callback button) clears pending state.
//   3. Invalid path keeps pending state for retry without re-clicking [➕].

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CallbackRouter } from '../../src/im/callback-router.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { WorkspaceCreateBroker } from '../../src/im/workspace-create-broker.js';
import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { workspaceCmd } from '../../src/im/commands/workspace.js';
import { newCmd } from '../../src/im/commands/new.js';
import { tryCreateWorkspaceFromPath } from '../../src/daemon/workspace-create-handler.js';
import { FakeRuntime } from '../session/fake-runtime.js';
import { FakeAdapter } from '../im/fake-adapter.js';
import { createLogger } from '../../src/util/logger.js';

import type { CommandContext } from '../../src/im/command-parser.js';
import type { InboundEvent } from '../../src/platform/types.js';
import type { AskUserQuestionBroker } from '../../src/permission/ask-broker.js';
import type { ElicitationBroker } from '../../src/permission/elicitation-broker.js';

interface Env {
  home: string;
  workspaces: WorkspaceManager;
  sessions: SessionManager;
  persistence: SessionPersistence;
  router: CallbackRouter;
  adapter: FakeAdapter;
  runtimes: FakeRuntime[];
  brokerCreate: WorkspaceCreateBroker;
}

async function setup(): Promise<Env> {
  const home = mkdtempSync(join(tmpdir(), 'tlive-onboarding-'));
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();

  const broker = new PermissionBroker();
  const runtimes: FakeRuntime[] = [];
  const sessions = new SessionManager({
    persistence,
    broker,
    runtimeFactory: (provider) => {
      const r = new FakeRuntime(provider as 'claude' | 'codex');
      runtimes.push(r);
      return r;
    },
  });

  const workspaces = new WorkspaceManager({ persistPath: join(home, 'workspaces.json') });
  await workspaces.load(); // empty file → no-op
  const adapter = new FakeAdapter('telegram');
  const brokerCreate = new WorkspaceCreateBroker();

  const askBroker = { resolve: () => true, pendingFor: () => [] } as unknown as AskUserQuestionBroker;
  const elicitationBroker = { resolve: () => true, pendingFor: () => [] } as unknown as ElicitationBroker;

  const router = new CallbackRouter({
    sessionManager: sessions,
    permissionBroker: broker,
    askBroker,
    elicitationBroker,
    adapters: { telegram: adapter },
    workspaceManager: workspaces,
    workspaceCreateBroker: brokerCreate,
    persistence,
  });

  return { home, workspaces, sessions, persistence, router, adapter, runtimes, brokerCreate };
}

async function teardown(env: Env): Promise<void> {
  await env.sessions.stopAll().catch(() => undefined);
  rmSync(env.home, { recursive: true, force: true });
}

/**
 * Build a CommandContext that pumps replies straight into the FakeAdapter,
 * mirroring bootstrap's inbound dispatch surface for slash commands.
 */
function buildCtx(env: Env, ev: InboundEvent, userId: string): CommandContext {
  return {
    inbound: ev,
    userId,
    sessionManager: env.sessions,
    workspaceManager: env.workspaces,
    permissionBroker: {} as never,
    askBroker: {} as never,
    elicitationBroker: {} as never,
    reply: async (text, opts) => {
      await env.adapter.send({
        chatId: ev.chatId,
        threadId: ev.threadId,
        text,
        replyMarkup: opts?.replyMarkup,
      });
    },
  };
}

describe('e2e: onboarding (empty state → first session)', () => {
  let env: Env;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await teardown(env); });

  it('walks T0-T11: empty state → /workspace → [➕] → path → bind → /new', async () => {
    const userId = 'u1';
    const chatId = 'chat-1';
    const channelType = 'telegram' as const;

    // Sanity — empty registry on boot.
    expect(env.workspaces.list()).toHaveLength(0);

    // Step 1: /workspace renders state B (no workspaces, only [➕ 新增]).
    const ev1: InboundEvent = {
      kind: 'text',
      messageId: 'm-in-1',
      channelType,
      chatId,
      userId,
      text: '/workspace',
      raw: {},
    };
    const ctx = buildCtx(env, ev1, userId);
    await workspaceCmd.run(ctx, []);

    const sentEmpty = env.adapter.byKind('send');
    expect(sentEmpty).toHaveLength(1);
    const emptyMsg = sentEmpty[0]!.args as { text?: string; replyMarkup?: { buttons?: Array<Array<{ text: string; callbackData?: string }>> } };
    expect(emptyMsg.text).toContain('此 chat 还没进入工作区');
    expect(emptyMsg.text).toContain('系统暂无任何工作区');
    const buttons = emptyMsg.replyMarkup?.buttons ?? [];
    const flat = buttons.flat();
    expect(flat).toHaveLength(1);
    expect(flat[0]!.text).toContain('新增工作区');
    expect(flat[0]!.callbackData).toBe('workspace:create:start');

    // Step 2: user clicks [➕ 新增工作区] → callback router opens broker pending state.
    env.adapter.calls.length = 0;
    const out = await env.router.route({
      data: 'workspace:create:start',
      userId,
      chatId,
      messageId: 'm-card-1',
      channelType,
    });
    expect(out).toEqual({ kind: 'handled', action: 'workspace:create:start' });
    const pending = env.brokerCreate.pendingFor(channelType, chatId);
    expect(pending).toBeDefined();
    expect(pending!.userId).toBe(userId);

    const promptCalls = env.adapter.byKind('send');
    expect(promptCalls).toHaveLength(1);
    const promptMsg = promptCalls[0]!.args as { text?: string };
    expect(promptMsg.text).toContain('请发送项目根目录');

    // Step 3: user sends absolute path. Use a real directory so fs.stat
    // succeeds and create() + bindChat() is exercised end-to-end.
    const projectDir = mkdtempSync(join(tmpdir(), 'tlive-onboard-proj-'));
    try {
      env.adapter.calls.length = 0;
      const ev3: InboundEvent = {
        kind: 'text',
        messageId: 'm-in-2',
        channelType,
        chatId,
        userId,
        text: projectDir,
        raw: {},
      };
      await tryCreateWorkspaceFromPath(projectDir, pending!, {
        adapter: env.adapter,
        workspaces: env.workspaces,
        workspaceCreateBroker: env.brokerCreate,
        logger: createLogger(),
      }, ev3);

      // Workspace registered, admin claimed, chat bound.
      const all = env.workspaces.list();
      expect(all).toHaveLength(1);
      const ws = all[0]!;
      expect(ws.workdir).toBe(projectDir);
      expect(env.workspaces.getRole(ws.id, userId)).toBe('admin');
      expect(env.workspaces.workspaceForChat(channelType, chatId)?.id).toBe(ws.id);
      // Pending state cleared.
      expect(env.brokerCreate.pendingFor(channelType, chatId)).toBeUndefined();

      // Reply confirms creation.
      const okCalls = env.adapter.byKind('send');
      expect(okCalls).toHaveLength(1);
      const okMsg = okCalls[0]!.args as { text?: string };
      expect(okMsg.text).toContain('✅');
      expect(okMsg.text).toContain(ws.name);
      expect(okMsg.text).toContain(projectDir);

      // Step 4: /new spawns a session in the freshly-bound workspace.
      env.adapter.calls.length = 0;
      const runtimeCountBefore = env.runtimes.length;
      const ev4: InboundEvent = {
        kind: 'text',
        messageId: 'm-in-3',
        channelType,
        chatId,
        userId,
        text: '/new',
        raw: {},
      };
      await newCmd.run(buildCtx(env, ev4, userId), []);

      // Runtime was constructed; the chat-level binding now owns the session.
      expect(env.runtimes.length).toBe(runtimeCountBefore + 1);
      const activeSid = env.workspaces.getActiveSessionId(channelType, chatId);
      expect(activeSid).toBeTruthy();
      const newCalls = env.adapter.byKind('send');
      expect(newCalls).toHaveLength(1);
      expect(String((newCalls[0]!.args as { text?: string }).text)).toContain('已起');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('cancel mid-flow via /cancel callback button', async () => {
    const userId = 'u1';
    const chatId = 'chat-2';
    const channelType = 'telegram' as const;

    // Open the create dialog.
    await env.router.route({
      data: 'workspace:create:start',
      userId, chatId, messageId: 'm-1', channelType,
    });
    expect(env.brokerCreate.pendingFor(channelType, chatId)).toBeDefined();

    // Click [❌ 取消].
    env.adapter.calls.length = 0;
    const out = await env.router.route({
      data: 'workspace:create:cancel',
      userId, chatId, messageId: 'm-1', channelType,
    });
    expect(out).toEqual({ kind: 'handled', action: 'workspace:create:cancel' });
    expect(env.brokerCreate.pendingFor(channelType, chatId)).toBeUndefined();

    const replies = env.adapter.byKind('send').map((c) => String((c.args as { text?: string }).text ?? ''));
    expect(replies.some((t) => t.includes('已取消'))).toBe(true);
  });

  it('invalid path replies error and keeps pending state for retry', async () => {
    const userId = 'u1';
    const chatId = 'chat-3';
    const channelType = 'telegram' as const;

    // Open dialog.
    await env.router.route({
      data: 'workspace:create:start',
      userId, chatId, messageId: 'm-1', channelType,
    });
    const pending = env.brokerCreate.pendingFor(channelType, chatId);
    expect(pending).toBeDefined();
    env.adapter.calls.length = 0;

    // Submit a clearly-nonexistent absolute path.
    const bogus = '/definitely/not/a/real/path/tlive-onboarding-xxx';
    const ev: InboundEvent = {
      kind: 'text',
      messageId: 'm-in-bad',
      channelType,
      chatId,
      userId,
      text: bogus,
      raw: {},
    };
    await tryCreateWorkspaceFromPath(bogus, pending!, {
      adapter: env.adapter,
      workspaces: env.workspaces,
      workspaceCreateBroker: env.brokerCreate,
      logger: createLogger(),
    }, ev);

    // Pending state PRESERVED so user can retry without re-clicking [➕].
    expect(env.brokerCreate.pendingFor(channelType, chatId)).toBeDefined();
    expect(env.workspaces.list()).toHaveLength(0);

    const replies = env.adapter.byKind('send').map((c) => String((c.args as { text?: string }).text ?? ''));
    expect(replies.some((t) => t.includes('无法访问'))).toBe(true);

    // Now retry with a valid path — should resolve pending state.
    const ok = mkdtempSync(join(tmpdir(), 'tlive-onboard-retry-'));
    try {
      env.adapter.calls.length = 0;
      await tryCreateWorkspaceFromPath(ok, env.brokerCreate.pendingFor(channelType, chatId)!, {
        adapter: env.adapter,
        workspaces: env.workspaces,
        workspaceCreateBroker: env.brokerCreate,
        logger: createLogger(),
      }, { ...ev, text: ok });
      expect(env.workspaces.list()).toHaveLength(1);
      expect(env.brokerCreate.pendingFor(channelType, chatId)).toBeUndefined();
    } finally {
      rmSync(ok, { recursive: true, force: true });
    }
  });

  it('non-directory path (file) replies error and preserves pending', async () => {
    const userId = 'u1';
    const chatId = 'chat-4';
    const channelType = 'telegram' as const;

    await env.router.route({
      data: 'workspace:create:start',
      userId, chatId, messageId: 'm-1', channelType,
    });
    const pending = env.brokerCreate.pendingFor(channelType, chatId)!;
    env.adapter.calls.length = 0;

    // Create a file (not a directory) and submit its path.
    const dir = mkdtempSync(join(tmpdir(), 'tlive-onboard-file-'));
    const filePath = join(dir, 'not-a-dir.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, 'hello');
    try {
      const ev: InboundEvent = {
        kind: 'text',
        messageId: 'm-in-file',
        channelType,
        chatId,
        userId,
        text: filePath,
        raw: {},
      };
      await tryCreateWorkspaceFromPath(filePath, pending, {
        adapter: env.adapter,
        workspaces: env.workspaces,
        workspaceCreateBroker: env.brokerCreate,
        logger: createLogger(),
      }, ev);

      // Pending preserved, no workspace created.
      expect(env.brokerCreate.pendingFor(channelType, chatId)).toBeDefined();
      expect(env.workspaces.list()).toHaveLength(0);

      const replies = env.adapter.byKind('send').map((c) => String((c.args as { text?: string }).text ?? ''));
      expect(replies.some((t) => t.includes('不是目录'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

