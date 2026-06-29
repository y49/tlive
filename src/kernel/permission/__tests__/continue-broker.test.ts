import { describe, it, expect, vi } from 'vitest';
import { ContinueBroker } from '../continue-broker.js';

describe('ContinueBroker', () => {
  it('fires onRequest with cwd/context and resolves with the reply', async () => {
    const b = new ContinueBroker();
    let captured: { requestId: string; cwd: string; context: string } | null = null;
    b.onRequest((r) => { captured = r; });
    const p = b.request({ cwd: '/r', context: 'done', timeoutSec: 5 });
    expect(captured).not.toBeNull();
    expect(captured!.cwd).toBe('/r');
    expect(captured!.context).toBe('done');
    b.answer(captured!.requestId, 'run tests');
    expect(await p).toBe('run tests');
  });

  it('resolves null on timeout', async () => {
    vi.useFakeTimers();
    const b = new ContinueBroker();
    const p = b.request({ cwd: '/r', context: 'done', timeoutSec: 1 });
    vi.advanceTimersByTime(1100);
    expect(await p).toBeNull();
    vi.useRealTimers();
  });

  it('answer on unknown requestId is a no-op', () => {
    const b = new ContinueBroker();
    expect(() => b.answer('nope', 'x')).not.toThrow();
  });
});
