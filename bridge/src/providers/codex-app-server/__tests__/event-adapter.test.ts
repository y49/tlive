import { describe, it, expect, beforeEach } from 'vitest';
import { CodexEventAdapter } from '../event-adapter.js';

describe('CodexEventAdapter — thread/turn lifecycle', () => {
  let adapter: CodexEventAdapter;

  beforeEach(() => {
    adapter = new CodexEventAdapter();
  });

  it('thread/started caches threadId, emits nothing', () => {
    const events = adapter.handle('thread/started', { thread: { id: 'thread-1' } });
    expect(events).toHaveLength(0);
  });

  it('turn/started emits status event', () => {
    adapter.handle('thread/started', { thread: { id: 'thread-1' } });
    const events = adapter.handle('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'status', sessionId: 'thread-1' });
  });

  it('turn/completed (status=completed) emits query_result with usage from tokenUsage cache', () => {
    adapter.handle('thread/started', { thread: { id: 'thread-1' } });
    adapter.handle('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 123, inputTokens: 100, cachedInputTokens: 10, outputTokens: 23, reasoningOutputTokens: 0 },
        last: { totalTokens: 123, inputTokens: 100, cachedInputTokens: 10, outputTokens: 23, reasoningOutputTokens: 0 },
        modelContextWindow: 200000,
      },
    });
    const events = adapter.handle('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'query_result',
      sessionId: 'thread-1',
      isError: false,
      usage: { inputTokens: 100, outputTokens: 23 },
    });
  });

  it('turn/completed (status=failed) emits query_result(isError=true) and error', () => {
    adapter.handle('thread/started', { thread: { id: 'thread-1' } });
    const events = adapter.handle('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'failed', items: [], error: { message: 'Out of budget' } },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'query_result', isError: true });
    expect(events[1]).toMatchObject({ kind: 'error', message: 'Out of budget' });
  });

  it('turn/completed (status=interrupted) emits single query_result(isError=false)', () => {
    adapter.handle('thread/started', { thread: { id: 'thread-1' } });
    const events = adapter.handle('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'interrupted', items: [] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'query_result', isError: false });
  });

  it('turn/completed without prior tokenUsage uses zeros and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter.handle('thread/started', { thread: { id: 'thread-1' } });
    const events = adapter.handle('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    expect(events[0]).toMatchObject({
      kind: 'query_result',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('reset() clears state', () => {
    adapter.handle('thread/started', { thread: { id: 'thread-1' } });
    adapter.handle('thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 5, inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        last: { totalTokens: 5, inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: null,
      },
    });
    adapter.reset();
    // After reset, tokenUsage cache is gone, turn/completed warns
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter.handle('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

import { vi } from 'vitest';
