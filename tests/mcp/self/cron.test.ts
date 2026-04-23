// tests/mcp/self/cron.test.ts
//
// Fake-timer cron firing + persistence.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarness, type McpTestHarness } from '../helpers.js';
import { CronEngine, shouldFireAt } from '../../../src/mcp/self/cron.js';

describe('CronEngine', () => {
  let harness: McpTestHarness;
  beforeEach(async () => { harness = await buildHarness(); });
  afterEach(async () => { await rm(harness.root, { recursive: true, force: true }); });

  it('shouldFireAt — daily triggers at the right minute', () => {
    const t = { id: 't', cron: null, at: null, daily: '09:00', weekly: null, workspaceId: 'w', prompt: 'p', provider: 'claude', createdAt: '' } as const;
    const target = new Date(2026, 0, 1, 9, 0).getTime();
    const other = new Date(2026, 0, 1, 10, 0).getTime();
    expect(shouldFireAt(t as never, target)).toBe(true);
    expect(shouldFireAt(t as never, other)).toBe(false);
  });

  it('shouldFireAt — cron 0 9 * * * matches 9:00', () => {
    const t = { id: 't', cron: '0 9 * * *', at: null, daily: null, weekly: null, workspaceId: 'w', prompt: 'p', provider: 'claude', createdAt: '' } as const;
    const target = new Date(2026, 0, 1, 9, 0).getTime();
    const other = new Date(2026, 0, 1, 9, 5).getTime();
    expect(shouldFireAt(t as never, target)).toBe(true);
    expect(shouldFireAt(t as never, other)).toBe(false);
  });

  it('shouldFireAt — at: once, blocks double-fire via lastRun', () => {
    const t = { id: 't', cron: null, at: '2026-01-01T09:00:00Z', daily: null, weekly: null, workspaceId: 'w', prompt: 'p', provider: 'claude', createdAt: '' } as const;
    const now = Date.parse('2026-01-01T09:05:00Z');
    expect(shouldFireAt(t as never, now)).toBe(true);
    expect(shouldFireAt(t as never, now, now)).toBe(false);
  });

  it('add + tick + save round-trip', async () => {
    const file = join(harness.root, 'schedules.json');
    const fired: string[] = [];
    const engine = new CronEngine(harness.deps, {
      file,
      executor: async (t) => { fired.push(t.id); },
    });
    await engine.load();
    const task = await engine.add({
      cron: '0 9 * * *', at: null, daily: null, weekly: null,
      workspaceId: 'w', prompt: 'standup', provider: 'claude',
    });
    const atMs = new Date(2026, 3, 22, 9, 0).getTime();
    const f = await engine.tick(atMs);
    expect(f).toHaveLength(1);
    expect(fired).toEqual([task.id]);

    // Re-tick at the same minute: blocked by lastRunAt
    const f2 = await engine.tick(atMs + 10_000);
    expect(f2).toHaveLength(0);

    // Fresh engine loads persisted state
    const engine2 = new CronEngine(harness.deps, { file });
    await engine2.load();
    expect(engine2.list()).toHaveLength(1);
    expect(await engine2.remove(task.id)).toBe(true);
  });

  it('start/stop registers unref interval without blocking', () => {
    const engine = new CronEngine(harness.deps, { tickMs: 1000 });
    engine.start();
    engine.stop();
  });
});
