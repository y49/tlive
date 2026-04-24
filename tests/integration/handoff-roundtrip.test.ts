// tests/integration/handoff-roundtrip.test.ts
//
// End-to-end verification of the Mode A ↔ Mode B handoff flow:
//   1. Boot a minimal IPC server wired to a real SessionManager + persistence.
//   2. Seed a live session, bind it as the workspace's activeSessionId.
//   3. Call `handoff.release` through the IPC client (simulating `tlive
//      handoff <alias>` / the Claude skill's `/tlive handoff` dispatch)
//      and verify the runtime is stopped + the session drops from the
//      live map.
//   4. Call `handoff.take` and verify a fresh LocalSession appears with the
//      *same* sdkSessionId (native jsonl compatibility).
//   5. Assert the workspace's activeSessionId invariant — a single writer
//      and identical id across the transition.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/session/manager.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { CostRollupStore } from '../../src/cost/rollups.js';
import { startIpcServer } from '../../src/ipc/server.js';
import { buildIpcDispatcher } from '../../src/ipc/dispatcher.js';
import { request } from '../../src/ipc/client.js';
import { FakeRuntime } from '../session/fake-runtime.js';

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'tlive-handoff-'));
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const broker = new PermissionBroker();

  const runtimes: FakeRuntime[] = [];
  const factory = (provider: 'claude' | 'codex') => {
    const r = new FakeRuntime(provider); runtimes.push(r); return r;
  };

  const sessions = new SessionManager({
    persistence,
    broker,
    runtimeFactory: factory,
  });

  const workspaces = new WorkspaceManager({ persistPath: join(home, 'workspaces.json') });
  const ws = workspaces.create({ name: 'ws', workdir: home });
  // Keep active-session state in sync with create/resume/stop so the test
  // can assert the workspace-level invariant that the IPC commands
  // ultimately serve (the production dispatcher leans on the same hooks
  // via SessionFrontend — here we wire a thin direct subscription).
  sessions.subscribe((ev) => {
    if (ev.kind === 'created' || ev.kind === 'resumed') {
      try { workspaces.bindActiveSession(ws.id, ev.session.id); }
      catch { /* conflict swallowed — test inspects state explicitly */ }
    }
    if (ev.kind === 'stopped') {
      if (workspaces.getActiveSessionId(ws.id) === ev.sessionId) {
        workspaces.clearActiveSession(ws.id);
      }
    }
  });

  const rollups = new CostRollupStore(join(home, 'cost', 'rollups.jsonl'));

  const socketPath = join(home, 'daemon.sock');
  const handler = buildIpcDispatcher({
    sessions,
    workspaces,
    persistence,
    rollups,
    startedAt: Date.now(),
    requestDaemonShutdown: () => undefined,
  });
  const ipc = await startIpcServer({ path: socketPath, handler });

  return { home, sessions, workspaces, ws, persistence, ipc, socketPath, runtimes };
}

describe('integration: handoff roundtrip', () => {
  let env: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => { env = await boot(); });
  afterEach(async () => {
    await env.ipc.close().catch(() => undefined);
    await env.sessions.stopAll().catch(() => undefined);
    rmSync(env.home, { recursive: true, force: true });
  });

  it('handoff.release stops the runtime and clears the workspace binding; handoff.take resurrects the same sdkSessionId', async () => {
    // --- Seed a live session (Mode A) ---
    const session = await env.sessions.createLocal({
      workspaceId: env.ws.id,
      provider: 'claude',
      workdir: env.home,
      source: 'im',
    });
    const sdkId = session.id;
    expect(env.sessions.get(sdkId)).toBeDefined();
    expect(env.workspaces.getActiveSessionId(env.ws.id)).toBe(sdkId);
    // Persist an explicit snapshot so resume() later has a jsonl row to reload.
    await env.persistence.saveSnapshot(session.snapshotLegacy());
    const runtimeBefore = env.runtimes[env.runtimes.length - 1]!;
    expect(runtimeBefore.stopCalls).toBe(0);

    // --- handoff.release via IPC ---
    const released = await request(
      { kind: 'handoff.release', alias: sdkId },
      { path: env.socketPath },
    );
    expect(released.kind).toBe('handoff.released');
    expect((released as { sdkId: string }).sdkId).toBe(sdkId);
    expect(env.sessions.get(sdkId)).toBeUndefined();
    expect(env.workspaces.getActiveSessionId(env.ws.id)).toBeNull();
    expect(runtimeBefore.stopCalls).toBe(1);

    // --- handoff.take via IPC ---
    const taken = await request(
      { kind: 'handoff.take', sdkId },
      { path: env.socketPath },
    );
    expect(taken.kind).toBe('handoff.taken');
    expect((taken as { sdkId: string }).sdkId).toBe(sdkId);

    const resumed = env.sessions.get(sdkId);
    expect(resumed).toBeDefined();
    expect(resumed!.id).toBe(sdkId); // same native jsonl identity
    expect(env.workspaces.getActiveSessionId(env.ws.id)).toBe(sdkId);

    // A second runtime instance was minted for the resumed session.
    expect(env.runtimes.length).toBeGreaterThan(1);
    const runtimeAfter = env.runtimes[env.runtimes.length - 1]!;
    expect(runtimeAfter).not.toBe(runtimeBefore);
    expect(runtimeAfter.started).toBe(true);
  });

  it('handoff.release surfaces an error for an unknown alias', async () => {
    const resp = await request(
      { kind: 'handoff.release', alias: 'nonexistent' },
      { path: env.socketPath },
    );
    expect(resp.kind).toBe('error');
    expect((resp as { message: string }).message).toMatch(/no session matches/);
  });

  it('handoff.take returns an error when the persisted meta is missing', async () => {
    const resp = await request(
      { kind: 'handoff.take', sdkId: 'missing' },
      { path: env.socketPath },
    );
    expect(resp.kind).toBe('error');
    expect((resp as { message: string }).message).toMatch(/cannot resume/);
  });

  it('workspace.activeSessionId single-writer invariant is preserved across a release+take roundtrip', async () => {
    const s = await env.sessions.createLocal({
      workspaceId: env.ws.id,
      provider: 'claude',
      workdir: env.home,
      source: 'im',
    });
    await env.persistence.saveSnapshot(s.snapshotLegacy());
    expect(env.workspaces.getActiveSessionId(env.ws.id)).toBe(s.id);

    await request({ kind: 'handoff.release', alias: s.id }, { path: env.socketPath });
    // Slot is empty — a fresh session could legally bind.
    expect(env.workspaces.getActiveSessionId(env.ws.id)).toBeNull();

    await request({ kind: 'handoff.take', sdkId: s.id }, { path: env.socketPath });
    // Slot rebinds to the identical id.
    expect(env.workspaces.getActiveSessionId(env.ws.id)).toBe(s.id);

    // Attempting to double-bind a different id while another session holds
    // the slot must throw — the invariant is enforced loudly.
    expect(() => env.workspaces.bindActiveSession(env.ws.id, 'other-id')).toThrow();
  });
});
