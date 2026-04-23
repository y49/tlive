// tests/cost/rollups.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CostRollupStore, aggregateDaily, dateKeyOf, type RollupDelta } from '../../src/cost/rollups.js';

describe('dateKeyOf', () => {
  it('formats epoch ms to YYYY-MM-DD UTC', () => {
    expect(dateKeyOf(Date.UTC(2026, 3, 22, 14, 30))).toBe('2026-04-22');
  });
});

describe('aggregateDaily', () => {
  it('buckets by (dateKey, workspaceId) and sums tokens + usd', () => {
    const deltas: RollupDelta[] = [
      { workspaceId: 'ws1', sdkSessionId: 's1', dateKey: '2026-04-22', deltaUsd: 0.10, deltaIn: 100, deltaOut: 50, at: 1 },
      { workspaceId: 'ws1', sdkSessionId: 's1', dateKey: '2026-04-22', deltaUsd: 0.05, deltaIn: 60, deltaOut: 30, at: 2 },
      { workspaceId: 'ws2', sdkSessionId: 's2', dateKey: '2026-04-22', deltaUsd: 0.20, deltaIn: 200, deltaOut: 100, at: 3 },
      { workspaceId: 'ws1', sdkSessionId: 's3', dateKey: '2026-04-21', deltaUsd: 0.01, deltaIn: 10, deltaOut: 5, at: 4 },
    ];
    const rolled = aggregateDaily(deltas);
    expect(rolled).toHaveLength(3);

    const ws1Today = rolled.find((r) => r.workspaceId === 'ws1' && r.dateKey === '2026-04-22')!;
    expect(ws1Today.totalUsd).toBeCloseTo(0.15);
    expect(ws1Today.totalIn).toBe(160);
    expect(ws1Today.totalOut).toBe(80);
    expect(ws1Today.sessionIds.size).toBe(1);
  });

  it('sort is dateKey desc then workspaceId asc', () => {
    const deltas: RollupDelta[] = [
      { workspaceId: 'b', sdkSessionId: 'x', dateKey: '2026-04-22', deltaUsd: 1, deltaIn: 1, deltaOut: 1, at: 1 },
      { workspaceId: 'a', sdkSessionId: 'y', dateKey: '2026-04-22', deltaUsd: 1, deltaIn: 1, deltaOut: 1, at: 2 },
      { workspaceId: 'a', sdkSessionId: 'z', dateKey: '2026-04-20', deltaUsd: 1, deltaIn: 1, deltaOut: 1, at: 3 },
    ];
    const rolled = aggregateDaily(deltas);
    expect(rolled[0]).toMatchObject({ dateKey: '2026-04-22', workspaceId: 'a' });
    expect(rolled[1]).toMatchObject({ dateKey: '2026-04-22', workspaceId: 'b' });
    expect(rolled[2]).toMatchObject({ dateKey: '2026-04-20', workspaceId: 'a' });
  });
});

describe('CostRollupStore', () => {
  let path: string;

  beforeEach(async () => {
    path = join(tmpdir(), `rollups-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  });

  afterEach(async () => { await fs.unlink(path).catch(() => undefined); });

  it('append + load round-trip', async () => {
    const store = new CostRollupStore(path);
    await store.append({ workspaceId: 'w1', sdkSessionId: 's1', dateKey: '2026-04-22', deltaUsd: 0.1, deltaIn: 10, deltaOut: 5, at: 1 });
    await store.append({ workspaceId: 'w1', sdkSessionId: 's1', dateKey: '2026-04-22', deltaUsd: 0.2, deltaIn: 20, deltaOut: 10, at: 2 });
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].deltaUsd).toBeCloseTo(0.1);
    expect(loaded[1].deltaUsd).toBeCloseTo(0.2);
  });

  it('load returns [] for missing file', async () => {
    const store = new CostRollupStore(path);
    expect(await store.load()).toEqual([]);
  });

  it('load skips malformed lines', async () => {
    await fs.mkdir(require('node:path').dirname(path), { recursive: true });
    await fs.writeFile(path, '{"valid":true}\nnot-json\n{"workspaceId":"w1","sdkSessionId":"s1","dateKey":"2026-04-22","deltaUsd":0.5,"deltaIn":1,"deltaOut":1,"at":1}\n', 'utf8');
    const store = new CostRollupStore(path);
    const loaded = await store.load();
    // First line JSON.parses but is not schema-conforming, still returned (schema enforced at aggregate time).
    // Second line skipped.
    // Third line is a valid delta.
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    expect(loaded.some((d) => d.workspaceId === 'w1' && d.dateKey === '2026-04-22')).toBe(true);
  });

  it('reset removes the file (idempotent)', async () => {
    const store = new CostRollupStore(path);
    await store.append({ workspaceId: 'w', sdkSessionId: 's', dateKey: '2026-04-22', deltaUsd: 1, deltaIn: 1, deltaOut: 1, at: 1 });
    await store.reset();
    await store.reset();
    expect(await store.load()).toEqual([]);
  });
});
