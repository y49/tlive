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

describe('CodexEventAdapter — item mapping', () => {
  let adapter: CodexEventAdapter;

  beforeEach(() => {
    adapter = new CodexEventAdapter();
    adapter.handle('thread/started', { thread: { id: 'thread-1' } });
  });

  it('item/started caches item without emitting', () => {
    const events = adapter.handle('item/started', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'item-1', type: 'commandExecution', command: 'ls' },
    });
    expect(events).toHaveLength(0);
    expect(adapter.getItem('item-1')).toMatchObject({ id: 'item-1', type: 'commandExecution' });
  });

  it('item/completed agentMessage → text_delta', () => {
    const events = adapter.handle('item/completed', {
      item: { id: 'i1', type: 'agentMessage', text: 'Hello user' },
    });
    expect(events).toEqual([{ kind: 'text_delta', text: 'Hello user' }]);
  });

  it('item/completed reasoning → reasoning_complete joining summary + content', () => {
    const events = adapter.handle('item/completed', {
      item: {
        id: 'i1', type: 'reasoning',
        summary: ['Summary 1', 'Summary 2'],
        content: ['Deep thought A', 'Deep thought B'],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('reasoning_complete');
    const text = (events[0] as any).text as string;
    expect(text).toContain('Summary 1');
    expect(text).toContain('Deep thought A');
  });

  it('item/completed commandExecution → tool_start + tool_result', () => {
    const events = adapter.handle('item/completed', {
      item: {
        id: 'i1', type: 'commandExecution',
        command: 'ls -la', cwd: '/tmp',
        aggregatedOutput: 'file1\nfile2',
        exitCode: 0,
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'tool_start',
      id: 'i1',
      name: 'Bash',
      input: { command: 'ls -la', cwd: '/tmp' },
    });
    expect(events[1]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'i1',
      content: 'file1\nfile2',
      isError: false,
    });
  });

  it('commandExecution with non-zero exitCode → tool_result isError=true', () => {
    const events = adapter.handle('item/completed', {
      item: { id: 'i1', type: 'commandExecution', command: 'false', cwd: '/', aggregatedOutput: '', exitCode: 1 },
    });
    expect(events[1]).toMatchObject({ isError: true });
  });

  it('item/completed fileChange → file_change_list with correct kind mapping', () => {
    const events = adapter.handle('item/completed', {
      item: {
        id: 'i1', type: 'fileChange',
        changes: [
          { path: '/tmp/a.ts', kind: 'add' },
          { path: '/tmp/b.ts', kind: 'update' },
          { path: '/tmp/c.ts', kind: 'delete' },
        ],
        status: 'completed',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'file_change_list',
      changes: [
        { path: '/tmp/a.ts', kind: 'add' },
        { path: '/tmp/b.ts', kind: 'update' },
        { path: '/tmp/c.ts', kind: 'delete' },
      ],
      status: 'completed',
    });
  });

  it('item/completed plan → agent_progress', () => {
    const events = adapter.handle('item/completed', {
      item: { id: 'i1', type: 'plan', text: 'Step 1: do X\nStep 2: do Y' },
    });
    expect(events).toEqual([{ kind: 'agent_progress', description: 'Step 1: do X\nStep 2: do Y' }]);
  });

  it('item/completed mcpToolCall → tool_start + tool_result', () => {
    const events = adapter.handle('item/completed', {
      item: {
        id: 'i1', type: 'mcpToolCall',
        server: 'filesystem', tool: 'readFile',
        arguments: { path: '/x' },
        result: 'contents',
        status: 'success',
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'tool_start',
      name: 'MCP:filesystem.readFile',
      input: { path: '/x' },
    });
    expect(events[1]).toMatchObject({ kind: 'tool_result' });
  });

  it('item/completed webSearch → agent_progress', () => {
    const events = adapter.handle('item/completed', {
      item: { id: 'i1', type: 'webSearch', query: 'how to X' },
    });
    expect(events).toEqual([{ kind: 'agent_progress', description: 'Searched: how to X' }]);
  });

  it('item/completed with unknown type → fallback agent_progress', () => {
    const events = adapter.handle('item/completed', {
      item: { id: 'i1', type: 'futureType' },
    });
    expect(events).toEqual([{ kind: 'agent_progress', description: '[codex:futureType]' }]);
  });

  it('delta notifications do not emit events', () => {
    expect(adapter.handle('item/agentMessage/delta', { itemId: 'i1', delta: 'Hello' })).toHaveLength(0);
    expect(adapter.handle('item/reasoning/textDelta', { itemId: 'i1', delta: 'think' })).toHaveLength(0);
    expect(adapter.handle('item/commandExecution/outputDelta', { itemId: 'i1', delta: 'out' })).toHaveLength(0);
  });

  it('turn/diff/updated and turn/plan/updated are ignored', () => {
    expect(adapter.handle('turn/diff/updated', { diff: 'xxx' })).toHaveLength(0);
    expect(adapter.handle('turn/plan/updated', { plan: 'xxx' })).toHaveLength(0);
  });
});
