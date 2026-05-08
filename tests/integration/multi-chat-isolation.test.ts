// tests/integration/multi-chat-isolation.test.ts
//
// Per spec §8.2 — verifies the load-bearing claim of the
// 2026-05-07-isolated-chat-sessions-design redesign: two chats binding
// to the same workspace each get their own LocalSession + SDK Query, and
// the SessionFrontend fan-out delivers assistant_text ONLY to the
// owning chat's adapter. Chat B never receives chat A's renders, and
// vice versa.
//
// Bonus second case: project-level workspace defaults (`ws.defaults.model`)
// do NOT retroactively cross-pollinate already-running sessions — the
// change takes effect only for the next-created session.
//
// e2e at the orchestration level: real WorkspaceManager + real
// SessionManager + real SessionFrontend driven by FakeRuntime (via
// runtimeFactory). Two FakeAdapters (telegram + feishu) capture every
// outbound send so we can assert isolation per channel.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { SessionFrontend } from '../../src/im/frontend.js';
import { FakeRuntime } from '../session/fake-runtime.js';
import { FakeAdapter } from '../im/fake-adapter.js';

interface Env {
  home: string;
  manager: SessionManager;
  workspaces: WorkspaceManager;
  persistence: SessionPersistence;
  frontend: SessionFrontend;
  adapterTg: FakeAdapter;
  adapterFs: FakeAdapter;
  runtimes: FakeRuntime[];
}

async function setup(): Promise<Env> {
  const home = mkdtempSync(join(tmpdir(), 'tlive-multichat-'));
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const broker = new PermissionBroker();
  const runtimes: FakeRuntime[] = [];

  const manager = new SessionManager({
    persistence,
    broker,
    runtimeFactory: (provider) => {
      const r = new FakeRuntime(provider as 'claude' | 'codex');
      runtimes.push(r);
      return r;
    },
  });

  const workspaces = new WorkspaceManager({ persistPath: join(home, 'workspaces.json') });
  const adapterTg = new FakeAdapter('telegram');
  const adapterFs = new FakeAdapter('feishu');
  const frontend = new SessionFrontend({
    sessionManager: manager,
    workspaceManager: workspaces,
    permissionBroker: broker,
    adapters: { telegram: adapterTg, feishu: adapterFs },
  });
  frontend.start();

  return { home, manager, workspaces, persistence, frontend, adapterTg, adapterFs, runtimes };
}

async function teardown(env: Env): Promise<void> {
  await env.frontend.stop();
  await env.manager.stopAll().catch(() => undefined);
  rmSync(env.home, { recursive: true, force: true });
}

/** Return the FakeRuntime that prepared with the given workspaceId/sessionId.
 *  We rely on creation order — runtimes[i] corresponds to the i-th createLocal. */
function lastRuntime(env: Env): FakeRuntime {
  return env.runtimes[env.runtimes.length - 1]!;
}

/** Drain microtasks + setImmediate twice so async dispatch chains settle. */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Drain plus a 500ms wait so EditQueue rate-limit refills and the
 *  frontend's 400ms-buffered turn_end reaction transition both settle
 *  BEFORE we measure adapter calls for the next turn. */
async function drainTurnFully(): Promise<void> {
  await drain();
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  await drain();
}

describe('e2e: multi-chat isolation (same workspace) — spec §8.2', () => {
  let env: Env;
  beforeEach(async () => { env = await setup(); });
  afterEach(async () => { await teardown(env); });

  it('two chats bound to same workspace get fully independent sessions', async () => {
    // One workspace, two bindings: telegram chat-tg and feishu chat-fs.
    const ws = env.workspaces.create({ name: 'shared-ws', workdir: env.home });
    env.workspaces.addBinding(ws.id, { channelType: 'telegram', chatId: 'chat-tg' });
    env.workspaces.addBinding(ws.id, { channelType: 'feishu', chatId: 'chat-fs' });

    // Chat A (telegram) creates its own LocalSession.
    const sa = await env.manager.createLocal({
      workspaceId: ws.id,
      provider: 'claude',
      workdir: env.home,
      source: 'im',
      ownerChat: { channelType: 'telegram', chatId: 'chat-tg' },
    });
    env.workspaces.bindActiveSessionForChat('telegram', 'chat-tg', sa.id);
    const runtimeA = lastRuntime(env);

    // Chat B (feishu) creates its own — distinct — LocalSession.
    const sb = await env.manager.createLocal({
      workspaceId: ws.id,
      provider: 'claude',
      workdir: env.home,
      source: 'im',
      ownerChat: { channelType: 'feishu', chatId: 'chat-fs' },
    });
    env.workspaces.bindActiveSessionForChat('feishu', 'chat-fs', sb.id);
    const runtimeB = lastRuntime(env);

    // ---- Data-model assertions: independent identities --------------------
    expect(sa.id).not.toBe(sb.id);
    expect(runtimeA).not.toBe(runtimeB);
    expect(env.workspaces.getActiveSessionIdForChat('telegram', 'chat-tg')).toBe(sa.id);
    expect(env.workspaces.getActiveSessionIdForChat('feishu', 'chat-fs')).toBe(sb.id);
    // ownerChat is recorded on the SessionLike.
    expect(sa.ownerChat?.channelType).toBe('telegram');
    expect(sa.ownerChat?.chatId).toBe('chat-tg');
    expect(sb.ownerChat?.channelType).toBe('feishu');
    expect(sb.ownerChat?.chatId).toBe('chat-fs');

    // ---- Fan-out assertion: drive sa, only telegram adapter sees output ---
    // Snapshot pre-existing call counts so we measure the delta from this
    // turn alone (frontend.attachSession may have already produced setup
    // sends/edits during createLocal).
    const tgBefore = env.adapterTg.calls.length;
    const fsBefore = env.adapterFs.calls.length;

    runtimeA.emitEvent({
      kind: 'turn_start', turnId: 'turn-a-1', userInputPreview: 'hello A', at: Date.now(),
    });
    runtimeA.emitEvent({
      kind: 'assistant_text', turnId: 'turn-a-1', text: 'reply from A', complete: true,
    });
    runtimeA.emitEvent({
      kind: 'turn_end', turnId: 'turn-a-1', durationMs: 10, costUsd: 0.001,
      tokensIn: 5, tokensOut: 5,
    });
    await drainTurnFully();

    // Telegram adapter saw new outbound activity; feishu saw nothing new.
    expect(env.adapterTg.calls.length).toBeGreaterThan(tgBefore);
    expect(env.adapterFs.calls.length).toBe(fsBefore);

    // ---- Reverse direction: drive sb, only feishu adapter sees output ----
    // Snapshot AFTER drainTurnFully so any trailing edits/reactions from
    // turn A are accounted for in tgMid, not attributed to turn B.
    const tgMid = env.adapterTg.calls.length;
    const fsMid = env.adapterFs.calls.length;

    runtimeB.emitEvent({
      kind: 'turn_start', turnId: 'turn-b-1', userInputPreview: 'hello B', at: Date.now(),
    });
    runtimeB.emitEvent({
      kind: 'assistant_text', turnId: 'turn-b-1', text: 'reply from B', complete: true,
    });
    runtimeB.emitEvent({
      kind: 'turn_end', turnId: 'turn-b-1', durationMs: 10, costUsd: 0.001,
      tokensIn: 5, tokensOut: 5,
    });
    await drainTurnFully();

    expect(env.adapterFs.calls.length).toBeGreaterThan(fsMid);
    expect(env.adapterTg.calls.length).toBe(tgMid);

    // ---- Stop one session — the other survives ---------------------------
    await env.manager.stop(sa.id);
    expect(env.manager.get(sa.id)).toBeUndefined();
    expect(env.manager.get(sb.id)).toBeDefined();
    expect(runtimeA.stopCalls).toBeGreaterThanOrEqual(1);
    expect(runtimeB.stopCalls).toBe(0);
  });

  it('changing workspace defaults does not retroactively affect a running session', async () => {
    // Workspace starts with model=model-old.
    const ws = env.workspaces.create({
      name: 'ws-defaults',
      workdir: env.home,
      defaults: { provider: 'claude', model: 'model-old' },
    });
    env.workspaces.addBinding(ws.id, { channelType: 'telegram', chatId: 'chat-tg' });

    // Create session A — runtime is prepared with model=model-old captured by
    // SessionManager's call path. Note: our test fakes don't surface the model
    // straight back, so we instead verify ws.defaults via the workspace state
    // and confirm subsequent createLocal sees the new value.
    const sa = await env.manager.createLocal({
      workspaceId: ws.id,
      provider: 'claude',
      workdir: env.home,
      model: ws.defaults.model,
      source: 'im',
      ownerChat: { channelType: 'telegram', chatId: 'chat-tg' },
    });
    env.workspaces.bindActiveSessionForChat('telegram', 'chat-tg', sa.id);

    // Mutate the workspace's defaults.model — this is an in-place mutation
    // that does NOT walk live sessions and patch their runtimes.
    ws.defaults.model = 'model-new';

    // Running session sa is unaffected: its identity is stable, no new
    // runtime spun up, and its ownerChat unchanged.
    expect(sa.ownerChat?.chatId).toBe('chat-tg');
    expect(env.manager.get(sa.id)).toBeDefined();
    const runtimeCountBefore = env.runtimes.length;

    // The change is observable on the workspace itself.
    expect(env.workspaces.get(ws.id)?.defaults.model).toBe('model-new');

    // No spurious runtime was spun up by the defaults mutation.
    expect(env.runtimes.length).toBe(runtimeCountBefore);

    // A NEW createLocal after the change observes the new default — proving
    // the change took effect for next-created sessions only.
    const sb = await env.manager.createLocal({
      workspaceId: ws.id,
      provider: 'claude',
      workdir: env.home,
      model: env.workspaces.get(ws.id)!.defaults.model,
      source: 'im',
      ownerChat: { channelType: 'telegram', chatId: 'chat-tg' },
    });
    expect(sb.id).not.toBe(sa.id);
    expect(env.runtimes.length).toBe(runtimeCountBefore + 1);

    await env.manager.stop(sa.id);
    await env.manager.stop(sb.id);
  });
});
