// tests/runtime/claude/event-adapter.test.ts
//
// Fixture-replay tests for ClaudeEventAdapter. Each case feeds a minimal
// SDK message shape and asserts the emitted NotificationEvent(s).

import { describe, it, expect } from 'vitest';
import { ClaudeEventAdapter } from '../../../src/runtime/claude/event-adapter.js';

describe('ClaudeEventAdapter', () => {
  it('emits turn_start on user message', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({ type: 'user', message: { content: 'hello world' } });
    expect(frame.events).toHaveLength(1);
    expect(frame.events[0]).toMatchObject({ kind: 'turn_start', userInputPreview: 'hello world' });
  });

  it('emits turn_end on result with cost + usage', () => {
    const adapter = new ClaudeEventAdapter();
    adapter.adapt({ type: 'user', message: { content: 'x' } });
    const frame = adapter.adapt({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.03,
      duration_ms: 500,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    });
    expect(frame.events[0]).toMatchObject({
      kind: 'turn_end', costUsd: 0.03, tokensIn: 10, tokensOut: 20, durationMs: 500,
    });
    expect(frame.usage).toMatchObject({
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 2, costUsd: 0.03,
    });
  });

  it('emits assistant_text from assistant text part', () => {
    const adapter = new ClaudeEventAdapter();
    adapter.adapt({ type: 'user', message: { content: 'x' } });
    const frame = adapter.adapt({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello back' }] },
    });
    expect(frame.events[0]).toMatchObject({ kind: 'assistant_text', text: 'Hello back', complete: true });
  });

  it('emits tool_use_start from assistant tool_use part', () => {
    const adapter = new ClaudeEventAdapter();
    adapter.adapt({ type: 'user', message: { content: 'x' } });
    const frame = adapter.adapt({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }] },
    });
    expect(frame.events[0]).toMatchObject({
      kind: 'tool_use_start', toolName: 'Bash', toolUseId: 'tu-1',
    });
  });

  it('emits parallel_tool_batch_start/end + batch metadata on multi tool_use', () => {
    const adapter = new ClaudeEventAdapter();
    adapter.adapt({ type: 'user', message: { content: 'x' } });
    const frame = adapter.adapt({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'tu-2', name: 'Read', input: { path: '/a' } },
        ],
      },
    });
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toContain('parallel_tool_batch_start');
    expect(kinds).toContain('parallel_tool_batch_end');
    const toolStarts = frame.events.filter((e): e is Extract<typeof e, { kind: 'tool_use_start' }> => e.kind === 'tool_use_start');
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0].batchId).toBeDefined();
    expect(toolStarts[0].batchSize).toBe(2);
    expect(toolStarts[0].batchIndex).toBe(0);
    expect(toolStarts[1].batchIndex).toBe(1);
  });

  it('emits todo_write when tool_use is TodoWrite', () => {
    const adapter = new ClaudeEventAdapter();
    adapter.adapt({ type: 'user', message: { content: 'x' } });
    const frame = adapter.adapt({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu-1',
          name: 'TodoWrite',
          input: { todos: [{ content: 'do it', status: 'pending' }] },
        }],
      },
    });
    const todo = frame.events.find((e) => e.kind === 'todo_write');
    expect(todo).toMatchObject({ kind: 'todo_write', items: [{ content: 'do it', status: 'pending' }] });
  });

  it('emits assistant_text_delta from stream_event text_delta', () => {
    const adapter = new ClaudeEventAdapter();
    adapter.adapt({ type: 'user', message: { content: 'x' } });
    const frame = adapter.adapt({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi ' } },
    });
    expect(frame.events[0]).toMatchObject({ kind: 'assistant_text_delta', text: 'hi ', partial: true });
  });

  it('emits thinking_delta + thinking_end from assistant thinking block', () => {
    const adapter = new ClaudeEventAdapter();
    adapter.adapt({ type: 'user', message: { content: 'x' } });
    const frame = adapter.adapt({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'let me think' }] },
    });
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toContain('thinking_delta');
    expect(kinds).toContain('thinking_end');
  });

  it('emits prompt_suggestion', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({ type: 'prompt_suggestion', suggestion: 'run tests' });
    expect(frame.events[0]).toMatchObject({ kind: 'prompt_suggestion' });
  });

  it('emits file_changed on FileChanged hook event', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'FileChanged',
      specific_output: { path: 'foo.ts', op: 'modified' },
    });
    expect(frame.events[0]).toMatchObject({ kind: 'file_changed', path: 'foo.ts', op: 'modified' });
  });

  it('emits hook_generic for unrecognized hook events', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'system',
      subtype: 'hook_started',
      hook_event: 'SessionStart',
    });
    expect(frame.events[0]).toMatchObject({ kind: 'hook_generic', event: 'SessionStart' });
  });

  it('emits pre_compact + post_compact on compact_boundary', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 1000 },
    });
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toContain('pre_compact');
    expect(kinds).toContain('post_compact');
  });

  it('emits api_throttle on rate_limit_event rejection', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: Date.now() / 1000 + 60 },
    });
    expect(frame.events[0]).toMatchObject({ kind: 'api_throttle' });
  });

  it('emits subagent_start on task_started', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      description: 'dispatch work',
    });
    expect(frame.events[0]).toMatchObject({
      kind: 'subagent_start', agentId: 'task-1', taskId: 'task-1',
    });
  });

  it('emits file_changed for each file in files_persisted', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'system',
      subtype: 'files_persisted',
      files: [{ filename: 'a.txt', file_id: 'f1' }, { filename: 'b.txt', file_id: 'f2' }],
    });
    expect(frame.events).toHaveLength(2);
    expect(frame.events.every((e) => e.kind === 'file_changed')).toBe(true);
  });

  it('emits tool_use_result from tool_result content block in user message', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok', is_error: false },
        ],
      },
    });
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toContain('tool_use_result');
    expect(kinds).not.toContain('turn_start');
    const tr = frame.events.find((e) => e.kind === 'tool_use_result');
    expect(tr).toMatchObject({
      kind: 'tool_use_result',
      toolUseId: 'tu-1',
      output: 'ok',
      ok: true,
    });
  });

  it('emits both tool_use_result and turn_start when user message mixes tool_result and text', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-2', content: 'done', is_error: false },
          { type: 'text', text: 'continue please' },
        ],
      },
    });
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toEqual(['tool_use_result', 'turn_start']);
    expect(frame.events[0]).toMatchObject({ kind: 'tool_use_result', toolUseId: 'tu-2', ok: true });
    expect(frame.events[1]).toMatchObject({ kind: 'turn_start', userInputPreview: 'continue please' });
  });

  it('tool_use_result with is_error=true sets ok=false', () => {
    const adapter = new ClaudeEventAdapter();
    const frame = adapter.adapt({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-3', content: 'boom', is_error: true },
        ],
      },
    });
    const tr = frame.events.find((e) => e.kind === 'tool_use_result');
    expect(tr).toMatchObject({ kind: 'tool_use_result', toolUseId: 'tu-3', ok: false });
  });

  it('unknown SDK message kind emits runtime_error{warn}, not hook_generic', () => {
    const adapter = new ClaudeEventAdapter();
    const result = adapter.adapt({ type: 'something_we_dont_know', some_field: 42 } as { type: string });
    expect(result.events.some((e) => e.kind === 'hook_generic')).toBe(false);
    const errs = result.events.filter((e) => e.kind === 'runtime_error');
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatchObject({
      kind: 'runtime_error',
      severity: 'warn',
      code: 'unknown_sdk_message_kind',
    });
  });

  it('assistant text block (B4 fix): emits assistant_text with turnId and complete=true', () => {
    const adapter = new ClaudeEventAdapter();
    // Simulate a minimal SDK SDKAssistantMessage shape: type='assistant', message.content array
    adapter.adapt({ type: 'user', message: { content: 'ping' } }); // establish a turnId
    const result = adapter.adapt({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello, I can hear you.' },
        ],
        role: 'assistant',
      },
      parent_tool_use_id: null,
      session_id: 'sess-123',
    });
    const textEvents = result.events.filter((e) => e.kind === 'assistant_text');
    expect(textEvents.length).toBe(1);
    expect(textEvents[0]).toMatchObject({
      kind: 'assistant_text',
      text: 'Hello, I can hear you.',
      complete: true,
    });
    // turnId must be a non-empty string (set by prior turn_start)
    expect((textEvents[0] as Extract<typeof textEvents[0], { kind: 'assistant_text' }>).turnId).toBeTruthy();
    // Must not emit hook_generic or runtime_error for a well-formed assistant message
    expect(result.events.some((e) => e.kind === 'hook_generic')).toBe(false);
    expect(result.events.some((e) => e.kind === 'runtime_error')).toBe(false);
  });
});
