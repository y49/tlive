/**
 * ClaudeAdapter — maps SDKMessage from @anthropic-ai/claude-agent-sdk
 * to CanonicalEvent[].
 *
 * Stateful: tracks block types for thinking vs text, streamed text
 * for dedup, and hidden tool IDs for filtering.
 */

import { canonicalEventSchema, type CanonicalEvent } from './schema.js';

// SDK types are loose — we define the shapes we actually consume.
export interface SDKMessage {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string;
  [key: string]: unknown;
}

const HIDDEN_TOOLS = new Set([
  'ToolSearch', 'TodoRead', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput',
]);

export class ClaudeAdapter {
  private currentBlockType: 'text' | 'thinking' | null = null;
  private hasStreamedText = false;
  private hiddenToolUseIds = new Set<string>();

  /** Reset state between queries. */
  reset(): void {
    this.currentBlockType = null;
    this.hasStreamedText = false;
    this.hiddenToolUseIds.clear();
  }

  /** Map one SDKMessage to zero or more CanonicalEvents. */
  mapMessage(msg: SDKMessage): CanonicalEvent[] {
    const parentToolUseId = msg.parent_tool_use_id as string | undefined;
    const events: CanonicalEvent[] = [];

    switch (msg.type) {
      case 'stream_event':
        this.handleStreamEvent(msg, events, parentToolUseId);
        break;

      case 'assistant':
        this.handleAssistant(msg, events, parentToolUseId);
        break;

      case 'user':
        this.handleUser(msg, events, parentToolUseId);
        break;

      case 'result':
        this.handleResult(msg, events);
        break;

      case 'system':
        this.handleSystem(msg, events, parentToolUseId);
        break;

      case 'tool_progress':
        this.handleToolProgress(msg, events, parentToolUseId);
        break;

      case 'rate_limit_event':
        this.handleRateLimit(msg, events);
        break;

      case 'prompt_suggestion':
        this.handlePromptSuggestion(msg, events);
        break;

      default:
        // Unknown message type — skip
        break;
    }

    // Validate every event through Zod
    return events.map(e => canonicalEventSchema.parse(e));
  }

  // ── stream_event ──

  private handleStreamEvent(
    msg: SDKMessage,
    events: CanonicalEvent[],
    parentToolUseId?: string,
  ): void {
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return;

    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (!block) return;

      if (block.type === 'thinking') {
        this.currentBlockType = 'thinking';
      } else if (block.type === 'text') {
        this.currentBlockType = 'text';
      } else if (block.type === 'tool_use') {
        const name = block.name as string;
        const id = block.id as string;

        if (HIDDEN_TOOLS.has(name)) {
          this.hiddenToolUseIds.add(id);
          return;
        }

        const ev: CanonicalEvent = {
          kind: 'tool_start',
          id,
          name,
          input: (block.input as Record<string, unknown>) ?? {},
          ...(parentToolUseId ? { parentToolUseId } : {}),
        };
        events.push(ev);
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return;

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (this.currentBlockType === 'thinking') {
          const ev: CanonicalEvent = {
            kind: 'thinking_delta',
            text: delta.text,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          };
          events.push(ev);
        } else {
          this.hasStreamedText = true;
          const ev: CanonicalEvent = {
            kind: 'text_delta',
            text: delta.text,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          };
          events.push(ev);
        }
      }
    }
  }

  // ── assistant ──

  private handleAssistant(
    msg: SDKMessage,
    events: CanonicalEvent[],
    parentToolUseId?: string,
  ): void {
    const message = msg.message as { content?: unknown[] } | undefined;
    if (!message?.content) return;

    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_use') {
        const name = b.name as string;
        const id = b.id as string;

        if (HIDDEN_TOOLS.has(name)) {
          this.hiddenToolUseIds.add(id);

          // Extract TodoWrite data as todo_update event
          if (name === 'TodoWrite') {
            const input = b.input as Record<string, unknown> | undefined;
            const todos = input?.todos as Array<{ content: string; status: string }> | undefined;
            if (todos?.length) {
              const ev: CanonicalEvent = {
                kind: 'todo_update',
                todos: todos.map(t => ({
                  content: t.content,
                  status: t.status as 'pending' | 'in_progress' | 'completed',
                })),
                ...(parentToolUseId ? { parentToolUseId } : {}),
              };
              events.push(ev);
            }
          }

          continue;
        }

        // Tool use resets the streamed flag — any text after tools is new
        this.hasStreamedText = false;

        const ev: CanonicalEvent = {
          kind: 'tool_start',
          id,
          name,
          input: (b.input as Record<string, unknown>) ?? {},
          ...(parentToolUseId ? { parentToolUseId } : {}),
        };
        events.push(ev);
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text && !this.hasStreamedText) {
        this.hasStreamedText = true;
        const ev: CanonicalEvent = {
          kind: 'text_delta',
          text: b.text,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        };
        events.push(ev);
      }
    }
  }

  // ── user ──

  private handleUser(
    msg: SDKMessage,
    events: CanonicalEvent[],
    parentToolUseId?: string,
  ): void {
    const message = msg.message as { content?: unknown[] } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block !== 'object' || block === null || !('type' in block)) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_result') {
        const toolUseId = b.tool_use_id as string;

        // Filter results for hidden tools
        if (this.hiddenToolUseIds.has(toolUseId)) continue;

        const rawContent = b.content;
        const contentStr = typeof rawContent === 'string'
          ? rawContent
          : JSON.stringify(rawContent ?? '');

        const ev: CanonicalEvent = {
          kind: 'tool_result',
          toolUseId,
          content: contentStr,
          isError: (b.is_error as boolean) || false,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        };
        events.push(ev);
      }
    }
  }

  // ── result ──

  private handleResult(
    msg: SDKMessage,
    events: CanonicalEvent[],
  ): void {
    const usage = msg.usage as { input_tokens: number; output_tokens: number } | undefined;
    const denials = Array.isArray(msg.permission_denials)
      ? (msg.permission_denials as Array<{ tool_name: string; tool_use_id: string }>).map(d => ({
        toolName: d.tool_name,
        toolUseId: d.tool_use_id,
      }))
      : undefined;

    // Extract per-model usage breakdown if available
    const rawModelUsage = msg.modelUsage as Record<string, {
      inputTokens?: number; outputTokens?: number;
      cacheReadInputTokens?: number; cacheCreationInputTokens?: number;
      costUSD?: number;
    }> | undefined;
    const modelUsage = rawModelUsage && Object.keys(rawModelUsage).length > 0
      ? Object.fromEntries(
          Object.entries(rawModelUsage).map(([model, u]) => [model, {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            ...(u.cacheReadInputTokens != null ? { cacheReadInputTokens: u.cacheReadInputTokens } : {}),
            ...(u.cacheCreationInputTokens != null ? { cacheCreationInputTokens: u.cacheCreationInputTokens } : {}),
            ...(u.costUSD != null ? { costUSD: u.costUSD } : {}),
          }]),
        )
      : undefined;

    if (msg.subtype === 'success') {
      const ev: CanonicalEvent = {
        kind: 'query_result',
        sessionId: msg.session_id as string,
        isError: (msg.is_error as boolean) || false,
        usage: {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          ...(msg.total_cost_usd != null ? { costUsd: msg.total_cost_usd as number } : {}),
          ...(modelUsage ? { modelUsage } : {}),
        },
        ...(denials && denials.length > 0 ? { permissionDenials: denials } : {}),
      };
      events.push(ev);
    } else {
      // Check if this is a user-initiated interrupt (e.g. /stop command)
      const errors = Array.isArray(msg.errors) ? msg.errors as string[] : [];
      const isInterrupt = errors.some(e => typeof e === 'string' && e.includes('result_type=user'));

      // Emit query_result with usage data so cost tracking works
      if (usage) {
        const ev: CanonicalEvent = {
          kind: 'query_result',
          sessionId: msg.session_id as string,
          isError: true,
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            ...(msg.total_cost_usd != null ? { costUsd: msg.total_cost_usd as number } : {}),
            ...(modelUsage ? { modelUsage } : {}),
          },
          ...(denials && denials.length > 0 ? { permissionDenials: denials } : {}),
        };
        events.push(ev);
      }

      // For interrupts, emit a clean message instead of raw SDK diagnostics
      if (isInterrupt) {
        events.push({ kind: 'error', message: 'Interrupted' } as CanonicalEvent);
      } else {
        const errorMsg = errors.length > 0 ? errors.join('; ') : 'Unknown error';
        events.push({ kind: 'error', message: errorMsg } as CanonicalEvent);
      }
    }
  }

  // ── system ──

  private handleSystem(
    msg: SDKMessage,
    events: CanonicalEvent[],
    parentToolUseId?: string,
  ): void {
    switch (msg.subtype) {
      case 'init': {
        const apiKeySource = msg.apiKeySource as string | undefined;
        if (apiKeySource) {
          console.log(`[tlive:sdk] Active auth source: ${apiKeySource}`);
        }
        const ev: CanonicalEvent = {
          kind: 'status',
          sessionId: msg.session_id as string,
          model: msg.model as string,
        };
        events.push(ev);
        break;
      }

      case 'task_started': {
        const ev: CanonicalEvent = {
          kind: 'agent_start',
          description: (msg.description as string) || 'Agent',
          ...(msg.task_id ? { taskId: msg.task_id as string } : {}),
          ...(parentToolUseId ? { parentToolUseId } : {}),
        };
        events.push(ev);
        break;
      }

      case 'task_progress': {
        const summary = msg.summary as string | undefined;
        const description = msg.description as string | undefined;
        const lastTool = msg.last_tool_name as string | undefined;
        const usage = msg.usage as { tool_uses: number; duration_ms: number } | undefined;

        const ev: CanonicalEvent = {
          kind: 'agent_progress',
          description: summary || description || 'Working...',
          ...(lastTool ? { lastTool } : {}),
          ...(usage ? { usage: { toolUses: usage.tool_uses, durationMs: usage.duration_ms } } : {}),
          ...(parentToolUseId ? { parentToolUseId } : {}),
        };
        events.push(ev);
        break;
      }

      case 'task_notification': {
        const ev: CanonicalEvent = {
          kind: 'agent_complete',
          summary: (msg.summary as string) || 'Done',
          status: (msg.status as 'completed' | 'failed' | 'stopped') || 'completed',
          ...(parentToolUseId ? { parentToolUseId } : {}),
        };
        events.push(ev);
        break;
      }
    }
  }

  // ── tool_progress ──

  private handleToolProgress(
    msg: SDKMessage,
    events: CanonicalEvent[],
    parentToolUseId?: string,
  ): void {
    const toolName = msg.tool_name as string | undefined;
    const elapsed = msg.elapsed_time_seconds as number | undefined;

    if (!toolName || !elapsed || elapsed <= 3) return;

    const ev: CanonicalEvent = {
      kind: 'tool_progress',
      toolName,
      elapsed,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    };
    events.push(ev);
  }

  // ── rate_limit_event ──

  private handleRateLimit(
    msg: SDKMessage,
    events: CanonicalEvent[],
  ): void {
    const info = msg.rate_limit_info as {
      status?: string;
      utilization?: number;
      resetsAt?: number;
    } | undefined;

    if (!info) return;
    if (info.status !== 'rejected' && info.status !== 'allowed_warning') return;

    const ev: CanonicalEvent = {
      kind: 'rate_limit',
      status: info.status,
      ...(info.utilization != null ? { utilization: info.utilization } : {}),
      ...(info.resetsAt != null ? { resetsAt: info.resetsAt } : {}),
    };
    events.push(ev);
  }

  // ── prompt_suggestion ──

  private handlePromptSuggestion(
    msg: SDKMessage,
    events: CanonicalEvent[],
  ): void {
    const suggestion = msg.suggestion as string | undefined;
    if (!suggestion) return;

    const ev: CanonicalEvent = {
      kind: 'prompt_suggestion',
      suggestion,
    };
    events.push(ev);
  }
}
