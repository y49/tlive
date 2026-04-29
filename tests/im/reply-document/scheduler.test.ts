import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplyScheduler } from '../../../src/im/reply-document/scheduler.js';
import { CRITICAL, NORMAL, TICK } from '../../../src/im/reply-document/edit-queue.js';

describe('ReplyScheduler — debounce 250ms', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('多次 schedule 在 debounce 窗内合一次 flush', async () => {
    const flushed: number[] = [];
    const sched = new ReplyScheduler(async (prio) => { flushed.push(prio); });
    sched.schedule('event', NORMAL);
    sched.schedule('event', NORMAL);
    sched.schedule('event', NORMAL);
    expect(flushed.length).toBe(0);
    await vi.advanceTimersByTimeAsync(260);
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toBe(NORMAL);
  });

  it('debounce 窗内 prio 取高(数小)', async () => {
    const flushed: number[] = [];
    const sched = new ReplyScheduler(async (prio) => { flushed.push(prio); });
    sched.schedule('event', NORMAL);
    sched.schedule('event', CRITICAL);
    await vi.advanceTimersByTimeAsync(260);
    expect(flushed[0]).toBe(CRITICAL);
  });
});

describe('ReplyScheduler — silence tick', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('1.5s 静默后补 tick,共 N≤20 次', async () => {
    const flushed: number[] = [];
    const sched = new ReplyScheduler(async (prio) => { flushed.push(prio); });
    sched.schedule('event', NORMAL);
    await vi.advanceTimersByTimeAsync(260);
    expect(flushed.length).toBe(1);

    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(1750);
    }
    const tickCount = flushed.filter(p => p === TICK).length;
    expect(tickCount).toBeLessThanOrEqual(20);
    expect(tickCount).toBeGreaterThanOrEqual(15);
  });

  it('event 重置 silence 计数', async () => {
    const flushed: number[] = [];
    const sched = new ReplyScheduler(async (prio) => { flushed.push(prio); });
    sched.schedule('event', NORMAL);
    await vi.advanceTimersByTimeAsync(260);

    // 让 5 个 silence ticks 跑过(消耗 silenceTickCount=5)
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1750);
    const ticksBeforeEvent = flushed.filter(p => p === TICK).length;
    expect(ticksBeforeEvent).toBeGreaterThanOrEqual(4);   // ~5 ticks landed

    // 事件 reset silenceTickCount 回 0
    sched.schedule('event', NORMAL);
    await vi.advanceTimersByTimeAsync(260);
    const flushedCountAfterReset = flushed.length;

    // 现在再静默 30s → 应该再触发 ~20 个 ticks(因为 count 被 reset 了)
    for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(1750);
    const ticksAfterReset = flushed.filter(p => p === TICK).length - ticksBeforeEvent;
    expect(ticksAfterReset).toBeLessThanOrEqual(20);
    expect(ticksAfterReset).toBeGreaterThanOrEqual(15);
  });
});

describe('ReplyScheduler — askBlocked 减速', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('askBlocked=true 时 tick 间隔为 3s', async () => {
    const flushed: number[] = [];
    const sched = new ReplyScheduler(async (prio) => { flushed.push(prio); });
    sched.schedule('event', NORMAL);
    await vi.advanceTimersByTimeAsync(260);
    sched.setAskBlocked(true);
    await vi.advanceTimersByTimeAsync(2000);
    const before = flushed.filter(p => p === TICK).length;
    await vi.advanceTimersByTimeAsync(1500);
    const after = flushed.filter(p => p === TICK).length;
    expect(after - before).toBe(1);
  });
});
