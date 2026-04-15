import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../messages/codex-adapter.js';
import type {
  ThreadEvent,
  ThreadItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  AgentMessageItem,
  ReasoningItem,
} from '@openai/codex-sdk';

// Helper to build valid ThreadItem objects conforming to SDK types
function msg(id: string, text = ''): AgentMessageItem {
  return { type: 'agent_message', id, text };
}
function cmd(id: string, command = '', extra: Partial<CommandExecutionItem> = {}): CommandExecutionItem {
  return { type: 'command_execution', id, command, aggregated_output: '', status: 'in_progress', ...extra };
}
function fc(id: string, changes: FileChangeItem['changes'] = [], status: FileChangeItem['status'] = 'completed'): FileChangeItem {
  return { type: 'file_change', id, changes, status };
}
function reason(id: string, text = ''): ReasoningItem {
  return { type: 'reasoning', id, text };
}
function mcp(id: string, tool: string, args: unknown = {}, extra: Partial<McpToolCallItem> = {}): McpToolCallItem {
  return { type: 'mcp_tool_call', id, server: '', tool, arguments: args, status: 'in_progress', ...extra };
}

describe('CodexAdapter', () => {
  function create() { return new CodexAdapter(); }

  describe('thread events', () => {
    it('maps thread.started to status', () => {
      const a = create();
      const events = a.adapt({ type: 'thread.started', thread_id: 'th_1' } as ThreadEvent);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('status');
      expect((events[0] as any).sessionId).toBe('th_1');
    });

    it('maps turn.started to empty', () => {
      expect(create().adapt({ type: 'turn.started' })).toHaveLength(0);
    });
  });

  describe('agent_message', () => {
    it('emits text_delta on item.updated', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: msg('msg_1') });
      const events = a.adapt({ type: 'item.updated', item: msg('msg_1', 'Hello') });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('text_delta');
      expect((events[0] as any).text).toBe('Hello');
    });

    it('emits delta (not full text) on subsequent updates', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: msg('msg_1') });
      a.adapt({ type: 'item.updated', item: msg('msg_1', 'Hello') });
      const events = a.adapt({ type: 'item.updated', item: msg('msg_1', 'Hello world') });
      expect(events).toHaveLength(1);
      expect((events[0] as any).text).toBe(' world');
    });

    it('emits full text on completed if no updates were received', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: msg('msg_1') });
      const events = a.adapt({ type: 'item.completed', item: msg('msg_1', 'Final answer') });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('text_delta');
      expect((events[0] as any).text).toBe('Final answer');
    });
  });

  describe('command_execution', () => {
    it('maps item.started to tool_start (Bash)', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: cmd('cmd_1', 'npm test') });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tool_start');
      expect((events[0] as any).name).toBe('Bash');
      expect((events[0] as any).input.command).toBe('npm test');
    });

    it('maps item.completed to tool_result', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: cmd('cmd_1', 'ls') });
      const events = a.adapt({ type: 'item.completed', item: cmd('cmd_1', 'ls', { aggregated_output: 'file1\nfile2', exit_code: 0, status: 'completed' }) });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tool_result');
      expect((events[0] as any).content).toBe('file1\nfile2');
      expect((events[0] as any).isError).toBe(false);
    });

    it('marks failed commands as errors', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: cmd('cmd_1', 'bad') });
      const events = a.adapt({ type: 'item.completed', item: cmd('cmd_1', 'bad', { aggregated_output: 'not found', exit_code: 127, status: 'failed' }) });
      expect((events[0] as any).isError).toBe(true);
    });

    it('links tool_result back to tool_start via toolUseId', () => {
      const a = create();
      const startEvents = a.adapt({ type: 'item.started', item: cmd('cmd_1', 'echo hi') });
      const toolId = (startEvents[0] as any).id;
      const endEvents = a.adapt({ type: 'item.completed', item: cmd('cmd_1', 'echo hi', { aggregated_output: 'hi', exit_code: 0, status: 'completed' }) });
      expect((endEvents[0] as any).toolUseId).toBe(toolId);
    });
  });

  describe('file_change', () => {
    it('maps add to Write tool_start', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: fc('fc_1', [{ path: '/src/new.ts', kind: 'add' }]) });
      expect(events[0].kind).toBe('tool_start');
      expect((events[0] as any).name).toBe('Write');
      expect((events[0] as any).input.file_path).toBe('/src/new.ts');
    });

    it('maps update to Edit tool_start', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: fc('fc_1', [{ path: '/src/old.ts', kind: 'update' }]) });
      expect((events[0] as any).name).toBe('Edit');
    });

    it('maps completed file_change to tool_result', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: fc('fc_1', [{ path: '/src/new.ts', kind: 'add' }]) });
      const events = a.adapt({ type: 'item.completed', item: fc('fc_1', [{ path: '/src/new.ts', kind: 'add' }], 'completed') });
      expect(events[0].kind).toBe('tool_result');
      expect((events[0] as any).isError).toBe(false);
    });

    it('marks failed file_change as error', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: fc('fc_1', [{ path: '/src/old.ts', kind: 'update' }]) });
      const events = a.adapt({ type: 'item.completed', item: fc('fc_1', [{ path: '/src/old.ts', kind: 'update' }], 'failed') });
      expect((events[0] as any).isError).toBe(true);
    });
  });

  describe('reasoning', () => {
    it('maps reasoning update to thinking_delta', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: reason('r_1') });
      const events = a.adapt({ type: 'item.updated', item: reason('r_1', 'Analyzing code...') });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('thinking_delta');
      expect((events[0] as any).text).toBe('Analyzing code...');
    });

    it('skips reasoning item.started (no output)', () => {
      const events = create().adapt({ type: 'item.started', item: reason('r_1') });
      expect(events).toHaveLength(0);
    });
  });

  describe('mcp_tool_call', () => {
    it('maps item.started to tool_start', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: mcp('mcp_1', 'search', { q: 'test' }) });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tool_start');
      expect((events[0] as any).name).toBe('search');
      expect((events[0] as any).input).toEqual({ q: 'test' });
    });

    it('maps item.completed to tool_result', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: mcp('mcp_1', 'search') });
      const events = a.adapt({ type: 'item.completed', item: mcp('mcp_1', 'search', {}, { result: { content: [], structured_content: { data: 'found' } }, status: 'completed' }) });
      expect(events[0].kind).toBe('tool_result');
    });

    it('filters hidden tools (TaskCreate, TodoRead, etc.)', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: mcp('mcp_h', 'TaskCreate', { subject: 'test' }) });
      expect(events).toHaveLength(0);
      // Completed event should also be filtered
      const completed = a.adapt({ type: 'item.completed', item: mcp('mcp_h', 'TaskCreate', {}, { status: 'completed' }) });
      expect(completed).toHaveLength(0);
    });
  });

  describe('turn lifecycle', () => {
    it('maps turn.completed to query_result', () => {
      const a = create();
      const events = a.adapt({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 200 } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('query_result');
      expect((events[0] as any).usage.inputTokens).toBe(500);
      expect((events[0] as any).usage.outputTokens).toBe(200);
    });

    it('maps turn.failed to error', () => {
      const a = create();
      const events = a.adapt({ type: 'turn.failed', error: { message: 'Rate limited' } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('error');
      expect((events[0] as any).message).toBe('Rate limited');
    });
  });

  describe('error event', () => {
    it('maps top-level error to error event', () => {
      const events = create().adapt({ type: 'error', message: 'Connection lost' });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('error');
      expect((events[0] as any).message).toBe('Connection lost');
    });
  });

  describe('reasoning_complete', () => {
    it('emits reasoning_complete on item.completed with ReasoningItem', () => {
      const adapter = new CodexAdapter();
      // Simulate reasoning_started then reasoning_completed
      const started = {
        type: 'item.started' as const,
        item: { id: 'r1', type: 'reasoning' as const, text: '' },
      };
      adapter.adapt(started as any);

      const completed = {
        type: 'item.completed' as const,
        item: { id: 'r1', type: 'reasoning' as const, text: 'My final reasoning' },
      };
      const events = adapter.adapt(completed as any);

      const reasoning = events.find((e) => e.kind === 'reasoning_complete');
      expect(reasoning).toBeDefined();
      expect((reasoning as any).text).toBe('My final reasoning');
      expect((reasoning as any).durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does not emit when text is empty', () => {
      const adapter = new CodexAdapter();
      adapter.adapt({ type: 'item.started', item: { id: 'r1', type: 'reasoning', text: '' } } as any);
      const events = adapter.adapt({
        type: 'item.completed',
        item: { id: 'r1', type: 'reasoning', text: '' },
      } as any);
      expect(events.find((e) => e.kind === 'reasoning_complete')).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('returns empty for unknown types', () => {
      expect(create().adapt({ type: 'unknown_future' } as any)).toHaveLength(0);
    });

    it('handles empty text update (no delta)', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: msg('msg_1') });
      const events = a.adapt({ type: 'item.updated', item: msg('msg_1', '') });
      expect(events).toHaveLength(0);
    });
  });
});
