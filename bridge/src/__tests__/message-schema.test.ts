import { describe, it, expect } from 'vitest';
import { canonicalEventSchema, type CanonicalEvent } from '../messages/schema.js';

describe('message-schema', () => {
  describe('text events', () => {
    it('validates text_delta', () => {
      const event = { kind: 'text_delta', text: 'hello' };
      const result = canonicalEventSchema.parse(event);
      expect(result.kind).toBe('text_delta');
      expect((result as any).text).toBe('hello');
    });
    it('validates thinking_delta', () => {
      const event = { kind: 'thinking_delta', text: 'reasoning...' };
      const result = canonicalEventSchema.parse(event);
      expect(result.kind).toBe('thinking_delta');
    });
    it('preserves unknown fields (passthrough)', () => {
      const event = { kind: 'text_delta', text: 'hi', futureField: 42 };
      const result = canonicalEventSchema.parse(event);
      expect((result as any).futureField).toBe(42);
    });
  });

  describe('tool events', () => {
    it('validates tool_start', () => {
      const event = { kind: 'tool_start', id: 'tu_1', name: 'Bash', input: { command: 'ls' } };
      expect(canonicalEventSchema.parse(event).kind).toBe('tool_start');
    });
    it('validates tool_start with parentToolUseId', () => {
      const event = { kind: 'tool_start', id: 'tu_2', name: 'Read', input: {}, parentToolUseId: 'tu_1' };
      expect((canonicalEventSchema.parse(event) as any).parentToolUseId).toBe('tu_1');
    });
    it('validates tool_result', () => {
      const event = { kind: 'tool_result', toolUseId: 'tu_1', content: 'output', isError: false };
      expect(canonicalEventSchema.parse(event).kind).toBe('tool_result');
    });
    it('validates tool_progress', () => {
      const event = { kind: 'tool_progress', toolName: 'Bash', elapsed: 5.2 };
      expect(canonicalEventSchema.parse(event).kind).toBe('tool_progress');
    });
  });

  describe('agent events', () => {
    it('validates agent_start', () => {
      const event = { kind: 'agent_start', description: 'Explore codebase', taskId: 'task_1' };
      expect(canonicalEventSchema.parse(event).kind).toBe('agent_start');
    });
    it('validates agent_progress', () => {
      const event = { kind: 'agent_progress', description: 'Working...', lastTool: 'Read', usage: { toolUses: 5, durationMs: 3000 } };
      expect(canonicalEventSchema.parse(event).kind).toBe('agent_progress');
    });
    it('validates agent_complete', () => {
      const event = { kind: 'agent_complete', summary: 'Done', status: 'completed' };
      expect(canonicalEventSchema.parse(event).kind).toBe('agent_complete');
    });
  });

  describe('query result events', () => {
    it('validates query_result', () => {
      const event = { kind: 'query_result', sessionId: 'sess_1', isError: false, usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 } };
      expect(canonicalEventSchema.parse(event).kind).toBe('query_result');
    });
    it('validates query_result with permission denials', () => {
      const event = { kind: 'query_result', sessionId: 's', isError: false, usage: { inputTokens: 100, outputTokens: 50 }, permissionDenials: [{ toolName: 'Bash', toolUseId: 'tu_1' }] };
      expect((canonicalEventSchema.parse(event) as any).permissionDenials).toHaveLength(1);
    });
    it('validates error', () => {
      expect(canonicalEventSchema.parse({ kind: 'error', message: 'fail' }).kind).toBe('error');
    });
  });

  describe('auxiliary events', () => {
    it('validates status', () => {
      expect(canonicalEventSchema.parse({ kind: 'status', sessionId: 's', model: 'claude-sonnet-4-5-20250514' }).kind).toBe('status');
    });
    it('validates prompt_suggestion', () => {
      expect(canonicalEventSchema.parse({ kind: 'prompt_suggestion', suggestion: 'Try this' }).kind).toBe('prompt_suggestion');
    });
    it('validates rate_limit', () => {
      expect(canonicalEventSchema.parse({ kind: 'rate_limit', status: 'rejected', utilization: 0.95 }).kind).toBe('rate_limit');
    });
  });

  describe('validation errors', () => {
    it('rejects unknown kind', () => {
      expect(() => canonicalEventSchema.parse({ kind: 'unknown' })).toThrow();
    });
    it('rejects missing required field', () => {
      expect(() => canonicalEventSchema.parse({ kind: 'text_delta' })).toThrow();
    });
  });

  describe('codex events', () => {
    it('validates reasoning_complete', () => {
      const event = { kind: 'reasoning_complete', text: 'my reasoning', durationMs: 5000 };
      const result = canonicalEventSchema.parse(event);
      expect(result.kind).toBe('reasoning_complete');
    });

    it('validates file_change_list', () => {
      const event = {
        kind: 'file_change_list',
        changes: [{ path: 'a.ts', kind: 'add' }, { path: 'b.ts', kind: 'update' }],
        status: 'completed',
      };
      const result = canonicalEventSchema.parse(event);
      expect(result.kind).toBe('file_change_list');
    });

    it('validates todo_list_update', () => {
      const event = {
        kind: 'todo_list_update',
        items: [{ text: 'do x', completed: false }],
      };
      const result = canonicalEventSchema.parse(event);
      expect(result.kind).toBe('todo_list_update');
    });
  });
});
