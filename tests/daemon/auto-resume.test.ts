// tests/daemon/auto-resume.test.ts
//
// Verifies spec §13.2:
//   - only workspaces with activeSessionId are considered
//   - running + fresh → resumeLocal is called
//   - running but stale (> cutoff) → skipped + cleared
//   - stopped meta → skipped
//   - resume failure → marked stopped + cleared

import { describe, it, expect, vi } from 'vitest';
import { autoResumeOnStartup } from '../../src/daemon/auto-resume.js';
import type { SessionManager } from '../../src/session/manager.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import type { SessionPersistence, SessionMeta } from '../../src/session/persistence.js';

function mkMeta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    sdkSessionId: overrides.sdkSessionId ?? 'sid',
    provider: 'claude',
    workspaceId: 'ws1',
    workdir: '/x',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'running',
    cost: { totalCost: 0, inputTokens: 0, outputTokens: 0 },
    pendingPermissions: [],
    pendingAskQuestions: [],
    pendingElicitations: [],
    ...overrides,
  };
}

describe('autoResumeOnStartup', () => {
  it('resumes a fresh running activeSessionId', async () => {
    const resumed: string[] = [];
    const sessions = {
      async resumeLocal(id: string) { resumed.push(id); return { id }; },
    } as unknown as SessionManager;

    const cleared: string[] = [];
    const workspaces = {
      list: () => [{ id: 'ws1', activeSessionId: 'sid-a' }],
      clearActiveSession(id: string) { cleared.push(id); },
    } as unknown as WorkspaceManager;

    const persistence = {
      async loadAllMeta() { return [mkMeta({ sdkSessionId: 'sid-a' })]; },
      async writeMeta() { /* noop */ },
    } as unknown as SessionPersistence;

    const report = await autoResumeOnStartup({ sessions, workspaces, persistence });
    expect(report.resumed).toEqual(['sid-a']);
    expect(report.failed).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it('skips a stale (>24h) running session and clears the binding', async () => {
    const resumed: string[] = [];
    const sessions = {
      async resumeLocal(id: string) { resumed.push(id); return { id }; },
    } as unknown as SessionManager;

    const cleared: string[] = [];
    const workspaces = {
      list: () => [{ id: 'ws1', activeSessionId: 'sid-stale' }],
      clearActiveSession(id: string) { cleared.push(id); },
    } as unknown as WorkspaceManager;

    const now = Date.now();
    const lastActivityAt = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const persistence = {
      async loadAllMeta() { return [mkMeta({ sdkSessionId: 'sid-stale', lastActivityAt })]; },
      async writeMeta() { /* noop */ },
    } as unknown as SessionPersistence;

    const report = await autoResumeOnStartup({ sessions, workspaces, persistence, cutoffHours: 24, now: () => now });
    expect(report.resumed).toEqual([]);
    expect(report.skippedStale).toContain('sid-stale');
    expect(resumed).toEqual([]);
    expect(cleared).toEqual(['ws1']);
  });

  it('marks stopped + notifies when resume throws', async () => {
    const notify = vi.fn();
    const sessions = {
      async resumeLocal() { throw new Error('sdk boom'); },
    } as unknown as SessionManager;

    const workspaces = {
      list: () => [{ id: 'ws1', activeSessionId: 'sid-x' }],
      clearActiveSession: vi.fn(),
    } as unknown as WorkspaceManager;

    const writeMeta = vi.fn().mockResolvedValue(undefined);
    const persistence = {
      async loadAllMeta() { return [mkMeta({ sdkSessionId: 'sid-x' })]; },
      writeMeta,
    } as unknown as SessionPersistence;

    const report = await autoResumeOnStartup({ sessions, workspaces, persistence, notify });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.reason).toContain('sdk boom');
    expect(notify).toHaveBeenCalled();
    expect(writeMeta).toHaveBeenCalled();
  });

  it('does nothing when activeSessionId is unset', async () => {
    const sessions = { async resumeLocal() { throw new Error('should not be called'); } } as unknown as SessionManager;
    const workspaces = { list: () => [{ id: 'ws1', activeSessionId: null }], clearActiveSession: vi.fn() } as unknown as WorkspaceManager;
    const persistence = { async loadAllMeta() { return []; } } as unknown as SessionPersistence;
    const report = await autoResumeOnStartup({ sessions, workspaces, persistence });
    expect(report.attempted).toBe(0);
  });
});
