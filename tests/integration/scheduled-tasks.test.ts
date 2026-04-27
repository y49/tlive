// tests/integration/scheduled-tasks.test.ts
//
// Cron pipeline end-to-end: schedule fires → session completes → IM notified.
//
// Uses the real CronEngine and SessionManager, with FakeRuntime standing in
// for Claude/Codex. Drives a single `tick()` at the cron target time, waits
// for the session_complete notifier callback, and asserts the notification
// was emitted + the session cleaned up.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { AskUserQuestionBroker } from '../../src/permission/ask-broker.js';
import { ElicitationBroker } from '../../src/permission/elicitation-broker.js';
import { AttachmentStore } from '../../src/attachment/store.js';
import { PolicyStore } from '../../src/permission/policy-store.js';
import { InMemorySignalBus } from '../../src/mcp/self/signals.js';
import { CronEngine } from '../../src/mcp/self/cron.js';
import { FakeRuntime } from '../session/fake-runtime.js';
import type { McpToolDeps } from '../../src/mcp/self/deps.js';

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'tlive-cron-int-'));
  const persistence = new SessionPersistence(root);
  await persistence.init();
  const permissionBroker = new PermissionBroker();
  const askBroker = new AskUserQuestionBroker();
  const elicitationBroker = new ElicitationBroker();
  const workspaces = new WorkspaceManager();
  const ws = workspaces.create({ name: 'cron-ws', workdir: root });
  const attachments = new AttachmentStore({ rootDir: join(root, 'attachments') });
  await attachments.init();
  const runtimes: FakeRuntime[] = [];
  const sessions = new SessionManager({
    persistence,
    broker: permissionBroker,
    askBroker,
    elicitationBroker,
    runtimeFactory: (provider) => { const r = new FakeRuntime(provider); runtimes.push(r); return r; },
    attachmentStore: attachments,
  });
  const signals = new InMemorySignalBus();
  const notifies: Array<{ sessionId: string; text: string }> = [];
  const deps: McpToolDeps = {
    sessions,
    workspaces,
    permissionBroker,
    askBroker,
    elicitationBroker,
    attachments,
    policyStoreFor: (id) => new PolicyStore(id, { file: join(root, 'workspaces', id, 'policies.json') }),
    signals,
    notifier: {
      async notify(sessionId, text) { notifies.push({ sessionId, text }); },
    },
    user: () => ({ id: 'cron', displayName: 'cron' }),
    dataDir: root,
  };

  return { root, deps, sessions, workspaces, ws, runtimes, notifies };
}

describe('integration: scheduled-tasks', () => {
  let env: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => { env = await boot(); });
  afterEach(async () => {
    await env.sessions.stopAll().catch(() => undefined);
    await rm(env.root, { recursive: true, force: true });
  });

  it('tick at target time fires the task; session completes; IM gets notified; session cleaned up', async () => {
    const engine = new CronEngine(env.deps, {
      file: join(env.root, 'schedules.json'),
    });
    await engine.load();

    const task = await engine.add({
      cron: '0 9 * * *', at: null, daily: null, weekly: null,
      workspaceId: env.ws.id,
      prompt: 'daily standup',
      provider: 'claude',
    });
    expect(engine.list()).toHaveLength(1);

    const targetMs = new Date(2026, 3, 22, 9, 0).getTime();

    // Subscribe BEFORE we kick the tick so we catch the `created` event
    // synchronously and complete the session only once cron has subscribed
    // to session.onEvent (i.e. createLocal has returned).
    const createdSessionIds: string[] = [];
    env.sessions.subscribe((ev) => {
      if (ev.kind === 'created') createdSessionIds.push(ev.session.id);
    });

    const tickPromise = engine.tick(targetMs);

    // Wait until cron has created the session and subscribed to its events.
    // The sequence is: factory -> prepare() -> emit('created') -> attachSink()
    // -> cron subscribes session.onEvent. By polling on createdSessionIds we
    // know the emit fired, and cron subscribes synchronously right after.
    const deadline = Date.now() + 2000;
    while (createdSessionIds.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(createdSessionIds.length).toBe(1);
    // One more microtask flush so cron's `.onEvent(cb)` registers before our emits.
    await new Promise((r) => setImmediate(r));

    expect(env.runtimes.length).toBe(1);
    const runtime = env.runtimes[0]!;
    runtime.emitEvent({ kind: 'assistant_text', turnId: 't1', text: 'done', complete: true });
    runtime.emitEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 10,
      costUsd: 0.0001, tokensIn: 10, tokensOut: 5,
    });
    runtime.emitEvent({
      kind: 'session_complete', reason: 'schedule_done', summary: 'standup delivered',
    });

    const fired = await tickPromise;
    expect(fired).toHaveLength(1);
    expect(fired[0]!.id).toBe(task.id);

    // Notifier received a schedule-tagged notification.
    expect(env.notifies.length).toBe(1);
    expect(env.notifies[0]!.text).toContain(task.id);
    expect(env.notifies[0]!.text).toContain('standup delivered');

    // Session was stopped after completion (cleanup).
    expect(env.sessions.listInfo().filter((s) => s.status.phase !== 'stopped').length).toBe(0);

    // Re-ticking the same minute is suppressed by lastRunAt.
    const second = await engine.tick(targetMs + 500);
    expect(second).toHaveLength(0);

    // Persisted lastRunAt roundtrip.
    const engine2 = new CronEngine(env.deps, { file: join(env.root, 'schedules.json') });
    await engine2.load();
    expect(engine2.list()[0]!.lastRunAt).toBeDefined();
  });
});
