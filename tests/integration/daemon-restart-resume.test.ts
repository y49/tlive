// tests/integration/daemon-restart-resume.test.ts
//
// Per spec §5.4 + v3.2.4 handoff item #2 — full integration of the
// `claude -r` semantics fix.
//
// Flow:
//   Phase 1: build a real WorkspaceManager + SessionPersistence under a
//            mkdtemp home. Create a workspace + chat binding + a fake
//            session, persist activeSessionId via wm.bindActiveSession +
//            wm.save, and write a .meta.json snapshot so hasSnapshot() is
//            true after restart.
//   Phase 2: simulate daemon restart by dropping all in-memory state. The
//            new WorkspaceManager re-loads workspaces.json (activeSessionId
//            preserved). The new SessionManager has an empty Map.
//            persistence remains on disk.
//   Phase 3: drive lazyResumeOrCreate as bootstrap's inbound handler does:
//            isLive returns false (sessions Map empty), hasPersistedSession
//            returns true (meta.json on disk) → branch === 'resumed', the
//            same sdkSessionId is reused, deps.createLocal is NOT called.
//
// No real Claude/Codex SDK is spawned. We stub deps.resume + deps.createLocal
// at the lazyResumeOrCreate boundary so the test exercises the manager's
// branching logic against the real persistence + workspace file round-trip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceManager } from '../../src/workspace/manager.js';
import { SessionPersistence, type SessionMeta } from '../../src/session/persistence.js';
import type { SessionLike } from '../../src/session/types.js';

interface Phase1 {
  home: string;
  workspaceId: string;
  sdkSessionId: string;
  workdir: string;
}

const CHAT = { channelType: 'telegram' as const, chatId: 'chat-1', userId: 'u1' };

function fakeSession(id: string): SessionLike {
  return {
    id,
    kind: 'local',
    shortAlias: id.slice(0, 8),
    workspaceId: 'ws',
    workspaceName: 'ws',
    workdir: '/tmp',
    provider: 'claude',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  } as unknown as SessionLike;
}

/**
 * Phase 1 — write workspaces.json + a meta.json snapshot so a fresh
 * WorkspaceManager + SessionPersistence under the same `home` resolve to
 * the same state on Phase 2 init.
 */
async function buildPhase1(opts: { withActive: boolean; metaSdkId?: string }): Promise<Phase1> {
  const home = mkdtempSync(join(tmpdir(), 'tlive-restart-'));
  const workdir = mkdtempSync(join(tmpdir(), 'tlive-restart-proj-'));

  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();

  const wm = new WorkspaceManager({ persistPath: join(home, 'workspaces.json') });
  await wm.load();
  const ws = wm.create({ name: 'restart', workdir });
  wm.setRole(ws.id, CHAT.userId, 'admin');
  wm.addBinding(ws.id, { channelType: CHAT.channelType, chatId: CHAT.chatId });

  const sdkSessionId = opts.metaSdkId ?? 'sdk-session-' + Math.random().toString(36).slice(2, 10);
  if (opts.withActive) {
    wm.bindActiveSessionForChat(CHAT.channelType, CHAT.chatId, sdkSessionId);
    // Write a real meta record so hasSnapshot is true on Phase 2.
    const meta: SessionMeta = {
      sdkSessionId,
      provider: 'claude',
      workspaceId: ws.id,
      workdir,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      status: 'stopped',
      cost: { totalCost: 0, inputTokens: 0, outputTokens: 0 },
      pendingPermissions: [],
      pendingAskQuestions: [],
      pendingElicitations: [],
    };
    await persistence.writeMeta(meta);
  }
  await wm.save();

  return { home, workspaceId: ws.id, sdkSessionId, workdir };
}

function teardown(p: Phase1): void {
  rmSync(p.home, { recursive: true, force: true });
  rmSync(p.workdir, { recursive: true, force: true });
}

describe('e2e: daemon restart preserves session via lazy resume', () => {
  let phase1: Phase1;
  afterEach(() => { if (phase1) teardown(phase1); });

  it('first message after restart takes resumed branch (not created)', async () => {
    phase1 = await buildPhase1({ withActive: true });

    // ---- Phase 2: fresh managers from disk ----
    const persistence2 = new SessionPersistence(join(phase1.home, 'sessions'));
    await persistence2.init();
    const wm2 = new WorkspaceManager({ persistPath: join(phase1.home, 'workspaces.json') });
    await wm2.load();

    // workspaces.json round-tripped activeSessionId.
    const wsLoaded = wm2.findByChat(CHAT.channelType, CHAT.chatId);
    expect(wsLoaded).toBeDefined();
    expect(wsLoaded!.id).toBe(phase1.workspaceId);
    expect(wm2.getActiveSessionIdForChat(CHAT.channelType, CHAT.chatId)).toBe(phase1.sdkSessionId);

    // meta.json on disk → hasSnapshot returns true.
    expect(await persistence2.hasSnapshot(phase1.sdkSessionId)).toBe(true);

    // ---- Phase 3: drive lazyResumeOrCreate as bootstrap inbound does ----
    const sessionsMap = new Map<string, SessionLike>(); // empty after "restart"
    const branchEvents: Array<{ branch: string; sessionId: string; workspaceId: string }> = [];
    const failedEvents: Array<unknown> = [];
    let resumeCalledWith: string | null = null;
    let createCalled = false;
    let inputSentTo: string | null = null;

    const out = await wm2.lazyResumeOrCreate(phase1.workspaceId, 'hello after restart', 'im', {
      chatChannelType: CHAT.channelType,
      chatId: CHAT.chatId,
      isLive: (id) => {
        const s = sessionsMap.get(id);
        return s !== undefined; // empty Map → false for the persisted id
      },
      hasPersistedSession: (id) => persistence2.hasSnapshot(id),
      resume: async (id) => {
        resumeCalledWith = id;
        const s = fakeSession(id);
        sessionsMap.set(id, s);
        return s;
      },
      createLocal: async () => {
        createCalled = true;
        return fakeSession('sdk-session-NEW');
      },
      sendInput: async (id) => { inputSentTo = id; },
      onBranch: (info) => branchEvents.push(info),
      onResumeFailed: (info) => failedEvents.push(info),
    });

    expect(out.action).toBe('resumed');
    expect(branchEvents).toHaveLength(1);
    expect(branchEvents[0]!.branch).toBe('resumed');
    expect(branchEvents[0]!.sessionId).toBe(phase1.sdkSessionId);
    expect(resumeCalledWith).toBe(phase1.sdkSessionId);
    expect(createCalled).toBe(false);
    expect(failedEvents).toHaveLength(0);
    expect(inputSentTo).toBe(phase1.sdkSessionId);

    // activeSessionId still pointing at the same id — not rotated.
    expect(wm2.getActiveSessionIdForChat(CHAT.channelType, CHAT.chatId)).toBe(phase1.sdkSessionId);
  });

  it('restart with corrupt jsonl falls through to created via onResumeFailed', async () => {
    phase1 = await buildPhase1({ withActive: true });

    // Phase 2.
    const persistence2 = new SessionPersistence(join(phase1.home, 'sessions'));
    await persistence2.init();
    const wm2 = new WorkspaceManager({ persistPath: join(phase1.home, 'workspaces.json') });
    await wm2.load();

    // hasSnapshot true (meta written), but resume returns null (corrupt).
    expect(await persistence2.hasSnapshot(phase1.sdkSessionId)).toBe(true);

    const branchEvents: Array<{ branch: string; sessionId: string; workspaceId: string }> = [];
    const failedEvents: Array<{ workspaceId: string; sdkSessionId: string; reason: string }> = [];
    let resumeCalled = false;
    let createCalled = false;

    const out = await wm2.lazyResumeOrCreate(phase1.workspaceId, 'hello', 'im', {
      chatChannelType: CHAT.channelType,
      chatId: CHAT.chatId,
      isLive: () => false,
      hasPersistedSession: (id) => persistence2.hasSnapshot(id),
      resume: async () => { resumeCalled = true; return null; }, // simulate corrupt jsonl
      createLocal: async () => { createCalled = true; return fakeSession('sdk-session-FRESH'); },
      sendInput: async () => { /* no-op */ },
      onBranch: (info) => branchEvents.push(info),
      onResumeFailed: (info) => failedEvents.push(info),
    });

    expect(resumeCalled).toBe(true);
    expect(createCalled).toBe(true);
    expect(out.action).toBe('created');
    expect(branchEvents).toHaveLength(1);
    expect(branchEvents[0]!.branch).toBe('created');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.sdkSessionId).toBe(phase1.sdkSessionId);
    expect(failedEvents[0]!.reason).toBe('resume returned null');

    // activeSessionId rotated to the new fresh id.
    expect(wm2.getActiveSessionIdForChat(CHAT.channelType, CHAT.chatId)).toBe('sdk-session-FRESH');
  });

  it('restart with no prior activeSessionId creates fresh', async () => {
    phase1 = await buildPhase1({ withActive: false });

    // Phase 2.
    const persistence2 = new SessionPersistence(join(phase1.home, 'sessions'));
    await persistence2.init();
    const wm2 = new WorkspaceManager({ persistPath: join(phase1.home, 'workspaces.json') });
    await wm2.load();

    const wsLoaded = wm2.findByChat(CHAT.channelType, CHAT.chatId);
    expect(wsLoaded).toBeDefined();
    expect(wm2.getActiveSessionIdForChat(CHAT.channelType, CHAT.chatId)).toBeNull(); // never bound in Phase 1

    let resumeCalled = false;
    let createCalled = false;
    const branchEvents: Array<{ branch: string }> = [];

    const out = await wm2.lazyResumeOrCreate(phase1.workspaceId, 'hello', 'im', {
      chatChannelType: CHAT.channelType,
      chatId: CHAT.chatId,
      isLive: () => false,
      hasPersistedSession: () => { throw new Error('hasPersistedSession must not be called when activeSessionId is null'); },
      resume: async () => { resumeCalled = true; return null; },
      createLocal: async () => { createCalled = true; return fakeSession('sdk-session-FIRST'); },
      sendInput: async () => { /* no-op */ },
      onBranch: (info) => branchEvents.push(info),
    });

    expect(resumeCalled).toBe(false);
    expect(createCalled).toBe(true);
    expect(out.action).toBe('created');
    expect(branchEvents[0]!.branch).toBe('created');
    expect(wm2.getActiveSessionIdForChat(CHAT.channelType, CHAT.chatId)).toBe('sdk-session-FIRST');
  });

  it('restart with activeSessionId set but meta missing falls through to created (no resume attempt)', async () => {
    phase1 = await buildPhase1({ withActive: true });

    // Delete the meta so hasSnapshot returns false even though activeSessionId is set.
    rmSync(join(phase1.home, 'sessions', `${phase1.sdkSessionId}.meta.json`));

    const persistence2 = new SessionPersistence(join(phase1.home, 'sessions'));
    await persistence2.init();
    const wm2 = new WorkspaceManager({ persistPath: join(phase1.home, 'workspaces.json') });
    await wm2.load();

    expect(await persistence2.hasSnapshot(phase1.sdkSessionId)).toBe(false);

    let resumeCalled = false;
    let createCalled = false;
    const branchEvents: Array<{ branch: string }> = [];

    const out = await wm2.lazyResumeOrCreate(phase1.workspaceId, 'hello', 'im', {
      chatChannelType: CHAT.channelType,
      chatId: CHAT.chatId,
      isLive: () => false,
      hasPersistedSession: (id) => persistence2.hasSnapshot(id),
      resume: async () => { resumeCalled = true; return null; },
      createLocal: async () => { createCalled = true; return fakeSession('sdk-session-AFTER-PRUNE'); },
      sendInput: async () => { /* no-op */ },
      onBranch: (info) => branchEvents.push(info),
    });

    expect(resumeCalled).toBe(false); // gated on hasPersistedSession
    expect(createCalled).toBe(true);
    expect(out.action).toBe('created');
    expect(branchEvents[0]!.branch).toBe('created');
  });
});

