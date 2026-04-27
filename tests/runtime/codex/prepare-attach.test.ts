// tests/runtime/codex/prepare-attach.test.ts
//
// Contract tests for CodexAppServerRuntime prepare/attachSink interface.
// Uses a minimal fake subprocess (in-process pipe pair) that speaks just
// enough JSON-RPC to satisfy initialize + thread/start.

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { CodexAppServerRuntime } from '../../../src/runtime/codex/runtime.js';
import type { EventSink } from '../../../src/runtime/types.js';
import type { NotificationEvent, UsageStats } from '../../../src/runtime/events.js';

/**
 * Minimal JSON-RPC server responding to initialize + thread/start.
 * Returns just enough to let CodexAppServerRuntime.prepare() succeed.
 */
function makeFakeCodexServer(): { spawnSubprocess: () => ChildProcess } {
  return {
    spawnSubprocess: () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();

      // Parse incoming JSONL from runtime → respond
      let buf = '';
      stdin.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          const id = msg.id as number;
          const method = msg.method as string;
          if (method === 'initialize') {
            stdout.push(JSON.stringify({ id, result: { serverInfo: { name: 'fake-codex' } } }) + '\n');
          } else if (method === 'thread/start') {
            stdout.push(JSON.stringify({ id, result: { thread: { id: 'codex-fake-thread-1' } } }) + '\n');
          } else if (method === 'thread/resume') {
            const params = (msg.params ?? {}) as Record<string, unknown>;
            const threadId = params.threadId as string;
            stdout.push(JSON.stringify({ id, result: { thread: { id: threadId } } }) + '\n');
          } else {
            // Generic fallback
            stdout.push(JSON.stringify({ id, result: {} }) + '\n');
          }
        }
      });

      // Build a minimal ChildProcess-shaped object
      const exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];
      const fakeProcess = {
        stdin,
        stdout,
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === 'exit') exitHandlers.push(cb as (code: number | null, signal: string | null) => void);
          return fakeProcess as unknown as EventEmitter;
        },
        off() { return fakeProcess as unknown as EventEmitter; },
        removeListener() { return fakeProcess as unknown as EventEmitter; },
        removeAllListeners() { return fakeProcess as unknown as EventEmitter; },
        kill() { exitHandlers.forEach((h) => h(0, null)); },
      } as unknown as ChildProcess;

      return fakeProcess;
    },
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

describe('CodexAppServerRuntime prepare/attachSink contract', () => {
  it('prepare returns sdkSessionId without calling sink', async () => {
    const deps = makeFakeCodexServer();
    const rt = new CodexAppServerRuntime(deps);
    const ctrl = new AbortController();
    const sink = captureSink();

    const { sdkSessionId } = await rt.prepare({ workdir: '/tmp', signal: ctrl.signal });
    expect(sdkSessionId).toBe('codex-fake-thread-1');
    // sink was not touched during prepare
    expect(sink.events).toEqual([]);
    ctrl.abort();
    await rt.stop();
  });

  it('attachSink before prepare throws', () => {
    const deps = makeFakeCodexServer();
    const rt = new CodexAppServerRuntime(deps);
    expect(() => rt.attachSink(captureSink())).toThrow(/before prepare/);
  });

  it('attachSink twice throws', async () => {
    const deps = makeFakeCodexServer();
    const rt = new CodexAppServerRuntime(deps);
    const ctrl = new AbortController();
    await rt.prepare({ workdir: '/tmp', signal: ctrl.signal });
    rt.attachSink(captureSink());
    expect(() => rt.attachSink(captureSink())).toThrow(/already/);
    ctrl.abort();
    await rt.stop();
  });

  it('prepare twice throws', async () => {
    const deps = makeFakeCodexServer();
    const rt = new CodexAppServerRuntime(deps);
    const ctrl = new AbortController();
    await rt.prepare({ workdir: '/tmp', signal: ctrl.signal });
    await expect(rt.prepare({ workdir: '/tmp', signal: ctrl.signal })).rejects.toThrow(/already prepared/);
    ctrl.abort();
    await rt.stop();
  });

  it('attachSink completes without error (no background consumer to start)', async () => {
    const deps = makeFakeCodexServer();
    const rt = new CodexAppServerRuntime(deps);
    const ctrl = new AbortController();
    await rt.prepare({ workdir: '/tmp', signal: ctrl.signal });
    expect(() => rt.attachSink(captureSink())).not.toThrow();
    ctrl.abort();
    await rt.stop();
  });
});
