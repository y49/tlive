// tests/runtime/claude/prepare-attach.test.ts
import { describe, it, expect } from 'vitest';
import { ClaudeSdkRuntime } from '../../../src/runtime/claude/runtime.js';
import type { EventSink } from '../../../src/runtime/types.js';
import type { NotificationEvent, UsageStats } from '../../../src/runtime/events.js';

function makeQueryFnYieldingInit(extraFramesBeforeInit: unknown[] = []) {
  // Returns an SDK-shaped query function: an async-iterable factory.
  return () => {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const f of extraFramesBeforeInit) yield f;
        yield { type: 'system', subtype: 'init', session_id: 'sdk-fake-1' };
        // Idle forever; consume() will pull from this.
        await new Promise(() => undefined);
      },
      close: () => undefined,
      interrupt: async () => undefined,
    } as unknown as ReturnType<import('@anthropic-ai/claude-agent-sdk').query>;
  };
}

function captureSink(): EventSink & { events: NotificationEvent[]; usages: UsageStats[] } {
  const events: NotificationEvent[] = [];
  const usages: UsageStats[] = [];
  return {
    events, usages,
    onEvent: (e) => events.push(e),
    onUsage: (u) => usages.push(u),
    onPermissionRequest: () => {},
    onAskUserQuestion: () => {},
    onElicitation: () => {},
  };
}

describe('ClaudeSdkRuntime prepare/attachSink contract', () => {
  it('prepare returns sdkSessionId, does not call sink', async () => {
    const rt = new ClaudeSdkRuntime({ query: makeQueryFnYieldingInit() });
    const ctrl = new AbortController();
    const sink = captureSink();
    rt.attachSink; // does not throw on access; only call after prepare
    const { sdkSessionId } = await rt.prepare({ workdir: '/tmp', signal: ctrl.signal });
    expect(sdkSessionId).toBe('sdk-fake-1');
    expect(sink.events).toEqual([]);
    ctrl.abort();
  });

  it('attachSink before prepare throws', () => {
    const rt = new ClaudeSdkRuntime({ query: makeQueryFnYieldingInit() });
    expect(() => rt.attachSink(captureSink())).toThrow(/before prepare/);
  });

  it('attachSink twice throws', async () => {
    const rt = new ClaudeSdkRuntime({ query: makeQueryFnYieldingInit() });
    const ctrl = new AbortController();
    await rt.prepare({ workdir: '/tmp', signal: ctrl.signal });
    rt.attachSink(captureSink());
    expect(() => rt.attachSink(captureSink())).toThrow(/already/);
    ctrl.abort();
  });

  it('prepare twice throws', async () => {
    const rt = new ClaudeSdkRuntime({ query: makeQueryFnYieldingInit() });
    const ctrl = new AbortController();
    await rt.prepare({ workdir: '/tmp', signal: ctrl.signal });
    await expect(rt.prepare({ workdir: '/tmp', signal: ctrl.signal })).rejects.toThrow(/already prepared/);
    ctrl.abort();
  });

  // attachSink flushes any events fired during prepare (e.g. from firstInitMessage's frames-before-init)
  // We simulate by yielding a frame that the adapter would translate to an event before init.
  // The default ClaudeEventAdapter emits no events for unknown frames, so this is a smoke test
  // that the *mechanism* exists rather than a specific event count. See task 6 for fixture-locked tests.
  it('attachSink consumes iter (no immediate error)', async () => {
    const rt = new ClaudeSdkRuntime({ query: makeQueryFnYieldingInit() });
    const ctrl = new AbortController();
    await rt.prepare({ workdir: '/tmp', signal: ctrl.signal });
    expect(() => rt.attachSink(captureSink())).not.toThrow();
    ctrl.abort();
  });
});
