// tests/runtime/claude/start-failure.test.ts
//
// Regression guard for ClaudeSdkRuntime.prepare() cleanup path: if the query
// stream errors before the `system/init` message arrives, the partially
// spawned Query must be closed and `prepared` reset so a retry is possible.
// Without this, a failed prepare() leaked the SDK subprocess and left the
// runtime un-recoverable.

import { describe, it, expect } from 'vitest';
import { ClaudeSdkRuntime } from '../../../src/runtime/claude/runtime.js';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

interface FakeHandle { query: Query; closeCalls: () => number }

function makeThrowingFake(err: Error): FakeHandle {
  let closeCalls = 0;
  const fake = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => { throw err; },
      };
    },
    close: () => { closeCalls += 1; },
  } as unknown as Query;
  return { query: fake, closeCalls: () => closeCalls };
}

describe('ClaudeSdkRuntime prepare() failure cleanup', () => {
  it('closes the Query and resets prepared flag if init stream throws', async () => {
    const handle = makeThrowingFake(new Error('simulated stream failure'));
    const rt = new ClaudeSdkRuntime({
      query: (() => handle.query) as never,
    });
    const ctrl = new AbortController();

    await expect(
      rt.prepare({ workdir: '/tmp', signal: ctrl.signal }),
    ).rejects.toThrow(/simulated stream failure/);

    expect(handle.closeCalls()).toBe(1);
    // Internal state: queryIter should be null so the control face treats the
    // runtime as not-yet-prepared (UnsupportedByRuntimeError on calls).
    const internal = rt as unknown as { queryIter: Query | null; prepared: boolean };
    expect(internal.queryIter).toBeNull();
    expect(internal.prepared).toBe(false);
  });

  it('is recoverable: a second prepare() on the same runtime does not throw "already prepared"', async () => {
    const firstHandle = makeThrowingFake(new Error('first attempt fail'));
    const rt = new ClaudeSdkRuntime({
      query: (() => firstHandle.query) as never,
    });
    const ctrl = new AbortController();

    await expect(
      rt.prepare({ workdir: '/tmp', signal: ctrl.signal }),
    ).rejects.toThrow(/first attempt fail/);

    // Swap the queryFn to a second fake and try again — must not hit the
    // "runtime already prepared" guard.
    const secondHandle = makeThrowingFake(new Error('second attempt fail'));
    (rt as unknown as { queryFn: () => Query }).queryFn = () => secondHandle.query;

    await expect(
      rt.prepare({ workdir: '/tmp', signal: ctrl.signal }),
    ).rejects.toThrow(/second attempt fail/);
    expect(secondHandle.closeCalls()).toBe(1);
  });

  it('closes the Query and rejects if the signal aborts after spawn but before init arrives', async () => {
    // Build a fake whose async iterator never yields — ClaudeSdkRuntime will
    // await firstInitMessage forever, but the try/catch also checks
    // `opts.signal.aborted` synchronously before iterating. To cover the
    // spawned-then-aborted branch, we abort synchronously inside queryFn.
    let closeCalls = 0;
    const neverYielding: Query = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => { /* never resolves */ }),
        };
      },
      close: () => { closeCalls += 1; },
    } as unknown as Query;

    const ctrl = new AbortController();
    const rt = new ClaudeSdkRuntime({
      query: (() => {
        // Abort mid-prepare — after queryIter assignment, before firstInitMessage.
        ctrl.abort();
        return neverYielding;
      }) as never,
    });

    await expect(
      rt.prepare({ workdir: '/tmp', signal: ctrl.signal }),
    ).rejects.toThrow(/aborted/);
    // `close()` must be called at least once (once from abort listener's
    // stop() call, and once from the catch block — either way it fired).
    expect(closeCalls).toBeGreaterThanOrEqual(1);
  });
});
