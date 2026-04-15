/**
 * CodexAdapter — maps Codex SDK ThreadEvent objects to CanonicalEvent[].
 * Mirrors ClaudeAdapter's pattern but for OpenAI Codex.
 */

import { canonicalEventSchema, type CanonicalEvent } from './schema.js';
import type {
  ThreadEvent,
  ThreadItem,
  ThreadStartedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  AgentMessageItem,
  ReasoningItem,
  TodoListItem,
} from '@openai/codex-sdk';

// Internal tools that should not be shown in the IM stream
const HIDDEN_TOOLS = new Set([
  'ToolSearch', 'TodoRead', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput',
]);

export class CodexAdapter {
  private lastAgentText = '';
  private itemIdToToolId = new Map<string, string>();
  private hiddenItemIds = new Set<string>();
  private toolIdCounter = 0;
  private threadId = '';
  private reasoningStartedAt = new Map<string, number>();

  adapt(event: ThreadEvent): CanonicalEvent[] {
    switch (event.type) {
      case 'thread.started':
        return this.adaptThreadStarted(event);
      case 'turn.started':
        return [];
      case 'item.started':
        return this.adaptItemStarted(event);
      case 'item.updated':
        return this.adaptItemUpdated(event);
      case 'item.completed':
        return this.adaptItemCompleted(event);
      case 'turn.completed':
        return this.adaptTurnCompleted(event);
      case 'turn.failed':
        return this.adaptTurnFailed(event);
      case 'error':
        return [this.validate({ kind: 'error', message: event.message || 'Unknown Codex error' })];
      default:
        return [];
    }
  }

  private validate(event: CanonicalEvent): CanonicalEvent {
    return canonicalEventSchema.parse(event) as CanonicalEvent;
  }

  private nextToolId(): string {
    return `codex-tool-${++this.toolIdCounter}`;
  }

  private adaptThreadStarted(event: ThreadStartedEvent): CanonicalEvent[] {
    this.threadId = event.thread_id || '';
    return [this.validate({
      kind: 'status',
      sessionId: this.threadId,
      model: 'codex',
    })];
  }

  private adaptItemStarted(event: ItemStartedEvent): CanonicalEvent[] {
    const item: ThreadItem = event.item;
    if (!item) return [];

    switch (item.type) {
      case 'agent_message': {
        this.lastAgentText = '';
        return [];
      }
      case 'command_execution': {
        const toolId = this.nextToolId();
        if (item.id) this.itemIdToToolId.set(item.id, toolId);
        const command = (item as CommandExecutionItem).command || '';
        return [this.validate({
          kind: 'tool_start',
          id: toolId,
          name: 'Bash',
          input: { command },
        })];
      }
      case 'file_change': {
        const toolId = this.nextToolId();
        if (item.id) this.itemIdToToolId.set(item.id, toolId);
        const changes = (item as FileChangeItem).changes || [];
        const firstChange = changes[0];
        const toolName = firstChange?.kind === 'add' ? 'Write' : 'Edit';
        const filePath = firstChange?.path || '';
        return [this.validate({
          kind: 'tool_start',
          id: toolId,
          name: toolName,
          input: { file_path: filePath },
        })];
      }
      case 'reasoning':
        if (item.id) this.reasoningStartedAt.set(item.id, Date.now());
        return [];
      case 'mcp_tool_call': {
        const mcp = item as McpToolCallItem;
        // Filter hidden tools
        if (HIDDEN_TOOLS.has(mcp.tool)) {
          if (item.id) this.hiddenItemIds.add(item.id);
          return [];
        }
        const toolId = this.nextToolId();
        if (item.id) this.itemIdToToolId.set(item.id, toolId);
        return [this.validate({
          kind: 'tool_start',
          id: toolId,
          name: mcp.tool || 'MCP',
          input: (mcp.arguments as Record<string, unknown>) || {},
        })];
      }
      case 'web_search': {
        const toolId = this.nextToolId();
        if (item.id) this.itemIdToToolId.set(item.id, toolId);
        return [this.validate({
          kind: 'tool_start',
          id: toolId,
          name: 'WebSearch',
          input: { query: (item as any).query || '' },
        })];
      }
      case 'todo_list': {
        const todo = item as TodoListItem;
        return [this.validate({
          kind: 'todo_list_update',
          items: todo.items.map((t) => ({ text: t.text, completed: t.completed })),
        })];
      }
      case 'error':
        return [this.validate({ kind: 'error', message: (item as any).message || 'Codex item error' })];
      default:
        return [];
    }
  }

  private adaptItemUpdated(event: ItemUpdatedEvent): CanonicalEvent[] {
    const item: ThreadItem = event.item;
    if (!item) return [];

    // Filter hidden tool updates
    if (item.id && this.hiddenItemIds.has(item.id)) return [];

    if (item.type === 'agent_message') {
      const fullText = (item as AgentMessageItem).text || '';
      const delta = fullText.slice(this.lastAgentText.length);
      this.lastAgentText = fullText;
      if (delta) {
        return [this.validate({ kind: 'text_delta', text: delta })];
      }
    }

    if (item.type === 'reasoning') {
      const text = (item as ReasoningItem).text || '';
      if (text) {
        return [this.validate({ kind: 'thinking_delta', text })];
      }
    }

    if (item.type === 'todo_list') {
      const todo = item as TodoListItem;
      return [this.validate({
        kind: 'todo_list_update',
        items: todo.items.map((t) => ({ text: t.text, completed: t.completed })),
      })];
    }

    return [];
  }

  private adaptItemCompleted(event: ItemCompletedEvent): CanonicalEvent[] {
    const item: ThreadItem = event.item;
    if (!item) return [];

    // Filter hidden tool results
    if (item.id && this.hiddenItemIds.has(item.id)) return [];

    if (item.type === 'command_execution') {
      const cmd = item as CommandExecutionItem;
      const toolId = this.itemIdToToolId.get(item.id) || item.id || '';
      return [this.validate({
        kind: 'tool_result',
        toolUseId: toolId,
        content: cmd.aggregated_output || '',
        isError: (cmd.exit_code !== undefined && cmd.exit_code !== 0) || cmd.status === 'failed',
      })];
    }

    if (item.type === 'file_change') {
      const fc = item as FileChangeItem;
      return [this.validate({
        kind: 'file_change_list',
        changes: fc.changes.map((c) => ({
          path: c.path,
          kind: c.kind === 'delete' ? 'delete' : c.kind === 'add' ? 'add' : 'update',
        })),
        status: fc.status,
      })];
    }

    if (item.type === 'mcp_tool_call') {
      const mcp = item as McpToolCallItem;
      const toolId = this.itemIdToToolId.get(item.id) || item.id || '';
      const content = mcp.error
        ? mcp.error.message
        : mcp.result
          ? JSON.stringify(mcp.result)
          : '';
      return [this.validate({
        kind: 'tool_result',
        toolUseId: toolId,
        content,
        isError: mcp.status === 'failed',
      })];
    }

    if (item.type === 'web_search') {
      const toolId = this.itemIdToToolId.get(item.id) || item.id || '';
      return [this.validate({
        kind: 'tool_result',
        toolUseId: toolId,
        content: 'Search completed',
        isError: false,
      })];
    }

    if (item.type === 'agent_message') {
      // Final text — if we didn't get updates, emit the full text
      const text = (item as AgentMessageItem).text || '';
      if (text && !this.lastAgentText) {
        return [this.validate({ kind: 'text_delta', text })];
      }
    }

    if (item.type === 'reasoning') {
      const text = (item as ReasoningItem).text || '';
      if (!text) {
        if (item.id) this.reasoningStartedAt.delete(item.id);
        return [];
      }
      const startedAt = item.id ? this.reasoningStartedAt.get(item.id) : undefined;
      const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
      if (item.id) this.reasoningStartedAt.delete(item.id);
      return [this.validate({ kind: 'reasoning_complete', text, durationMs })];
    }

    if (item.type === 'todo_list') {
      const todo = item as TodoListItem;
      return [this.validate({
        kind: 'todo_list_update',
        items: todo.items.map((t) => ({ text: t.text, completed: t.completed })),
      })];
    }

    return [];
  }

  private adaptTurnCompleted(event: TurnCompletedEvent): CanonicalEvent[] {
    const usage = event.usage;
    // Codex SDK may report 0 tokens in turn.completed (token data comes via
    // internal thread/tokenUsage/updated which the SDK doesn't expose).
    // Log actual values for debugging.
    if (usage) {
      console.log(`[codex-adapter] turn.completed usage: in=${usage.input_tokens} cached=${usage.cached_input_tokens} out=${usage.output_tokens}`);
    }
    return [this.validate({
      kind: 'query_result',
      sessionId: this.threadId,
      isError: false,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
    })];
  }

  private adaptTurnFailed(event: TurnFailedEvent): CanonicalEvent[] {
    const error = event.error;
    return [this.validate({
      kind: 'error',
      message: error?.message || 'Codex turn failed',
    })];
  }
}
