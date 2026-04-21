import { describe, it, expect } from 'vitest';
import { ClaudeEventAdapter } from '../../src/runtime/claude-event-adapter.js';

const adapter = new ClaudeEventAdapter();

describe('ClaudeEventAdapter', () => {
  it('emits activity_text for assistant text blocks', () => {
    const frame = adapter.adapt({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(frame.events).toEqual([{ kind: 'activity_text', text: 'hello' }]);
  });

  it('emits activity_tool for tool_use blocks', () => {
    const frame = adapter.adapt({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    expect(frame.events).toEqual([
      { kind: 'activity_tool', toolName: 'Bash', toolInput: JSON.stringify({ command: 'ls' }) },
    ]);
  });

  it('emits todo_update for TodoWrite tool_use', () => {
    const frame = adapter.adapt({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'TodoWrite',
        input: { todos: [{ content: 'a', status: 'pending' }] } }] },
    });
    expect(frame.events).toEqual([{ kind: 'todo_update', items: [{ content: 'a', status: 'pending' }] }]);
  });

  it('emits reasoning_summary for thinking blocks', () => {
    const frame = adapter.adapt({
      type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] },
    });
    expect(frame.events).toEqual([{ kind: 'reasoning_summary', text: 'pondering' }]);
  });

  it('emits session_complete + usage for result', () => {
    const frame = adapter.adapt({
      type: 'result', result: 'done',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01, duration_ms: 123,
    });
    expect(frame.events).toEqual([{ kind: 'session_complete', summary: 'done' }]);
    expect(frame.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.01, durationMs: 123 });
  });

  it('filters unknown types to []', () => {
    expect(adapter.adapt({ type: 'mystery' })).toEqual({ events: [] });
  });

  it('defensive against missing content', () => {
    expect(adapter.adapt({ type: 'assistant' })).toEqual({ events: [] });
    expect(adapter.adapt({ type: 'assistant', message: {} })).toEqual({ events: [] });
  });
});
