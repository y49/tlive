// tests/integration/workspace-switch.test.ts
//
// Per spec §4.2 — workspace switching follows claude -r semantics: stop the
// current session (interrupt + stop, jsonl preserved on disk), swap the chat
// binding, and resume the target workspace's prior session when its
// activeSessionId + jsonl exist on disk.
//
// e2e at the orchestration level: real WorkspaceManager + CallbackRouter +
// real SessionManager driven by FakeRuntime (via runtimeFactory). No real
// Claude/Codex SDK is spawned. The persistence directory is a real mkdtemp
// so `persistence.hasSnapshot` exercises the actual fs probe.

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
import { FakeRuntime } from '../session/fake-runtime.js';
import { FakeAdapter } from '../im/fake-adapter.js';
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
  const home = mkdtempSync(join(tmpdir(), 'tlive-ws-switch-'));
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

describe('e2e: workspace switch (claude -r semantics)', () => {
  let env: Env;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await teardown(env); });

  it('switching workspaces stops the current session and rebinds the chat', async () => {
    const wsA = env.workspaces.create({ name: 'a', workdir: join(env.home, 'a') });
    const wsB = env.workspaces.create({ name: 'b', workdir: join(env.home, 'b') });
    env.workspaces.bindChat({workspaceId: wsA.id,  channelType: 'telegram', chatId: 'chat-1' });
    env.workspaces.setRole(wsA.id, 'u1', 'admin');

    // Spin a real LocalSession in workspace A so the switch has a live session
    // to interrupt + stop.
    const session = await env.sessions.createLocal({
      workspaceId: wsA.id,
      provider: 'claude',
      workdir: wsA.workdir,
      source: 'im',
    });
    env.workspaces.bindActiveSession('telegram', 'chat-1', session.id);
    const runtimeA = env.runtimes[0]!;
    expect(runtimeA.stopCalls).toBe(0);

    const out = await env.router.route({
      data: `workspace:switch:${wsB.id}`,
      userId: 'u1',
      chatId: 'chat-1',
      messageId: 'm1',
      channelType: 'telegram',
    });

    expect(out.kind).toBe('handled');
    // Binding moved A → B.
    expect(env.workspaces.workspaceForChat('telegram', 'chat-1')?.id).toBe(wsB.id);
    // A's session was stopped (interrupt+stop both flow through to runtime.stop).
    expect(runtimeA.stopCalls).toBeGreaterThanOrEqual(1);
    // B has no prior session → reply contains "暂无活跃会话".
    const replies = env.adapter.byKind('send').map((c) => String((c.args as { text?: string }).text ?? ''));
    expect(replies.some((t) => t.includes('已切到工作区'))).toBe(true);
    expect(replies.some((t) => t.includes('暂无活跃会话'))).toBe(true);
  });

  it('switching back to a workspace this chat previously left does NOT auto-resume (chat-level isolation)', async () => {
    // Per spec §3 (Iso #1+) sessions are per (channel, chatId) — not per
    // workspace. When chat-1 leaves wsA via switchChat, its activeSessionId
    // goes with it: unbindChat wipes the ChatInstance for c1, and
    // bindChat back to wsA later starts a fresh instance with no prior
    // session. So switching back is just a fresh bind, not a resume.
    const wsA = env.workspaces.create({ name: 'a', workdir: join(env.home, 'a') });
    const wsB = env.workspaces.create({ name: 'b', workdir: join(env.home, 'b') });
    env.workspaces.bindChat({workspaceId: wsA.id,  channelType: 'telegram', chatId: 'chat-1' });
    // u1 must be admin in both workspaces so role-gated switch handler passes.
    env.workspaces.setRole(wsA.id, 'u1', 'admin');
    env.workspaces.setRole(wsB.id, 'u1', 'admin');

    const sessionA = await env.sessions.createLocal({
      workspaceId: wsA.id,
      provider: 'claude',
      workdir: wsA.workdir,
      source: 'im',
    });
    env.workspaces.bindActiveSession('telegram', 'chat-1', sessionA.id);
    await env.persistence.saveSnapshot(sessionA.snapshotLegacy());

    // A → B drops chat-1's binding to wsA entirely.
    await env.router.route({
      data: `workspace:switch:${wsB.id}`,
      userId: 'u1', chatId: 'chat-1', messageId: 'm1', channelType: 'telegram',
    });
    expect(env.workspaces.workspaceForChat('telegram', 'chat-1')?.id).toBe(wsB.id);
    // Per chat-level isolation, the prior chat-1+wsA binding is gone — its
    // activeSessionId went with it.
    expect(env.workspaces.listChatInstances().filter((c) => c.workspaceId === wsA.id)).toHaveLength(0);

    env.adapter.calls.length = 0;

    // B → A creates a fresh binding for chat-1 in wsA with no active session.
    const runtimesBefore = env.runtimes.length;
    await env.router.route({
      data: `workspace:switch:${wsA.id}`,
      userId: 'u1', chatId: 'chat-1', messageId: 'm2', channelType: 'telegram',
    });
    expect(env.workspaces.workspaceForChat('telegram', 'chat-1')?.id).toBe(wsA.id);
    expect(env.workspaces.getActiveSessionId('telegram', 'chat-1')).toBeNull();
    // No new resume was attempted on switch.
    expect(env.runtimes.length).toBe(runtimesBefore);
    const replies = env.adapter.byKind('send').map((c) => String((c.args as { text?: string }).text ?? ''));
    expect(replies.some((t) => t.includes('暂无活跃会话'))).toBe(true);
  });

  it('switching to a workspace with no prior activeSession just sends "no active" reply', async () => {
    const wsA = env.workspaces.create({ name: 'a', workdir: join(env.home, 'a') });
    const wsB = env.workspaces.create({ name: 'b', workdir: join(env.home, 'b') });
    env.workspaces.bindChat({workspaceId: wsA.id,  channelType: 'telegram', chatId: 'chat-1' });
    env.workspaces.setRole(wsA.id, 'u1', 'admin');
    // wsB has no activeSessionId, no session ever created.

    const runtimeCountBefore = env.runtimes.length;

    await env.router.route({
      data: `workspace:switch:${wsB.id}`,
      userId: 'u1', chatId: 'chat-1', messageId: 'm1', channelType: 'telegram',
    });

    expect(env.workspaces.workspaceForChat('telegram', 'chat-1')?.id).toBe(wsB.id);
    // No new runtime spun up — resumeLocal not called.
    expect(env.runtimes.length).toBe(runtimeCountBefore);
    const replies = env.adapter.byKind('send').map((c) => String((c.args as { text?: string }).text ?? ''));
    expect(replies.some((t) => t.includes('已切到工作区'))).toBe(true);
    expect(replies.some((t) => t.includes('暂无活跃会话'))).toBe(true);
    // No "已恢复" reply since no resume was attempted.
    expect(replies.some((t) => t.includes('已恢复'))).toBe(false);
  });
});
