// src/runtime/codex/event-adapter.ts
//
// Maps codex-app-server JSON-RPC notifications to NotificationEvent frames
// (spec §3.4). Produces the unified AdaptedFrame { events: NotificationEvent[];
// usage? } matching claude/event-adapter.ts.
//
// The set of forwarded JSON-RPC methods is owned by CodexAppServerRuntime —
// this adapter must gracefully no-op on unknown method names (return empty
// frame) instead of crashing.

import { randomBytes } from 'node:crypto';
import type { NotificationEvent, UsageStats } from '../events.js';

export interface AdaptedFrame {
  events: NotificationEvent[];
  usage?: UsageStats;
}

interface ThreadItem {
  id: string;
  type: string;
  [k: string]: unknown;
}

interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  [k: string]: unknown;
}

export class CodexEventAdapter {
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private turnStartedAt = 0;
  private recentItems = new Map<string, ThreadItem>();
  private tokenUsage: TokenUsageSummary | null = null;

  /** Dispatch a codex-app-server JSON-RPC notification and return the frame. */
  handle(method: string, params: unknown): AdaptedFrame {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'thread/started': {
        this.threadId = (p.thread as { id?: string } | undefined)?.id ?? null;
        return { events: [] };
      }
      case 'thread/tokenUsage/updated': {
        this.tokenUsage = this.extractUsage(p.tokenUsage);
        return { events: [] };
      }
      case 'thread/status/changed':
      case 'thread/closed':
        return { events: [] };
      case 'turn/started': {
        const turn = (p.turn ?? {}) as { id?: string; userInput?: string };
        this.currentTurnId = typeof turn.id === 'string' ? turn.id : randomBytes(4).toString('hex');
        this.turnStartedAt = Date.now();
        return {
          events: [{
            kind: 'turn_start',
            turnId: this.currentTurnId,
            userInputPreview: String(turn.userInput ?? '').slice(0, 80),
            at: this.turnStartedAt,
          }],
        };
      }
      case 'turn/completed':
        return this.handleTurnCompleted(p);
      case 'item/started':
        return this.handleItemStarted(p);
      case 'item/completed':
        return { events: this.handleItemCompleted(p) };
      case 'item/agentMessage/delta': {
        const text = String(p.delta ?? '');
        if (!text) return { events: [] };
        return {
          events: [{
            kind: 'assistant_text_delta',
            turnId: this.currentTurnId ?? 'unknown',
            text,
            partial: true,
          }],
        };
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const text = String(p.delta ?? '');
        if (!text) return { events: [] };
        return {
          events: [{
            kind: 'thinking_delta',
            turnId: this.currentTurnId ?? 'unknown',
            text,
            partial: true,
          }],
        };
      }
      case 'error':
        return {
          events: [{
            kind: 'runtime_error',
            severity: 'warn',
            code: 'codex_notification_error',
            message: String(p.message ?? 'Unknown error'),
          }],
        };
      // Best-effort suppression of deltas that don't have a clean NotificationEvent
      // counterpart. Renderers don't need them; keeping adapters terse.
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/mcpToolCall/progress':
      case 'item/plan/delta':
      case 'item/commandExecution/terminalInteraction':
      case 'turn/diff/updated':
      case 'turn/plan/updated':
      case 'serverRequest/resolved':
        return { events: [] };
      default:
        return { events: [] };
    }
  }

  /** Retrieve an item cached during item/started for approval-bridge lookups. */
  getItem(itemId: string): ThreadItem | undefined {
    return this.recentItems.get(itemId);
  }

  reset(): void {
    this.threadId = null;
    this.recentItems.clear();
    this.tokenUsage = null;
    this.currentTurnId = null;
    this.turnStartedAt = 0;
  }

  getCurrentTurnId(): string | null { return this.currentTurnId; }

  private handleTurnCompleted(p: Record<string, unknown>): AdaptedFrame {
    const turn = p.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
    const status = turn?.status ?? 'completed';
    const tokensIn = this.tokenUsage?.inputTokens ?? 0;
    const tokensOut = this.tokenUsage?.outputTokens ?? 0;
    const cost = this.tokenUsage?.costUsd ?? 0;
    const usage: UsageStats = {
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cacheReadTokens: this.tokenUsage?.cacheReadTokens,
      cacheCreationTokens: this.tokenUsage?.cacheCreationTokens,
      costUsd: cost,
    };
    const turnId = this.currentTurnId ?? String(turn?.id ?? 'unknown');
    const duration = this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
    const events: NotificationEvent[] = [
      { kind: 'turn_end', turnId, durationMs: duration, costUsd: cost, tokensIn, tokensOut },
    ];
    if (status === 'failed') {
      events.push({
        kind: 'runtime_error',
        severity: 'warn',
        code: 'codex_turn_failed',
        message: turn?.error?.message ?? 'Codex turn failed',
      });
    }
    // Clear per-turn state
    this.recentItems.clear();
    this.tokenUsage = null;
    this.currentTurnId = null;
    this.turnStartedAt = 0;
    return { events, usage };
  }

  private handleItemStarted(p: Record<string, unknown>): AdaptedFrame {
    const item = p.item as ThreadItem | undefined;
    if (!item) return { events: [] };
    if (item.id) this.recentItems.set(item.id, item);
    // Emit tool_use_start for command/mcp items so renderers see the "tool
    // dispatched" moment. fileChange + plan + reasoning + agentMessage remain
    // emitted only on item/completed.
    switch (item.type) {
      case 'commandExecution': {
        const input = { command: (item.command as string) ?? '', cwd: (item.cwd as string) ?? '' };
        return {
          events: [{
            kind: 'tool_use_start',
            turnId: this.currentTurnId ?? 'unknown',
            toolUseId: String(item.id),
            toolName: 'Bash',
            input,
          }],
        };
      }
      case 'mcpToolCall': {
        const server = (item.server as string) ?? '?';
        const tool = (item.tool as string) ?? '?';
        const args = (item.arguments as Record<string, unknown>) ?? {};
        return {
          events: [{
            kind: 'tool_use_start',
            turnId: this.currentTurnId ?? 'unknown',
            toolUseId: String(item.id),
            toolName: `MCP:${server}.${tool}`,
            input: args,
          }],
        };
      }
      default:
        return { events: [] };
    }
  }

  private handleItemCompleted(p: Record<string, unknown>): NotificationEvent[] {
    const item = p.item as ThreadItem | undefined;
    if (!item) return [];
    if (item.id) this.recentItems.set(item.id, item);
    const turnId = this.currentTurnId ?? 'unknown';
    switch (item.type) {
      case 'agentMessage': {
        const raw = String(item.text ?? '');
        // Some models (gpt-oss, minimax) smuggle reasoning inside <think>...</think>.
        const closeIdx = raw.indexOf('</think>');
        const events: NotificationEvent[] = [];
        if (closeIdx >= 0) {
          let head = raw.slice(0, closeIdx);
          const openMatch = head.match(/^\s*<think>/);
          if (openMatch) head = head.slice(openMatch[0].length);
          const reasoning = head.trim();
          if (reasoning.length > 0) {
            events.push({ kind: 'thinking_delta', turnId, text: reasoning, partial: true });
            events.push({ kind: 'thinking_end', turnId, totalTokens: reasoning.length });
          }
          const tail = raw.slice(closeIdx + '</think>'.length).trim();
          if (tail.length > 0) {
            events.push({ kind: 'assistant_text', turnId, text: tail, complete: true });
          }
          return events;
        }
        return [{ kind: 'assistant_text', turnId, text: raw, complete: true }];
      }
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? (item.summary as string[]).filter(Boolean) : [];
        const content = Array.isArray(item.content) ? (item.content as string[]).filter(Boolean) : [];
        const text = [...summary, ...content].join('\n\n');
        if (!text) return [];
        return [
          { kind: 'thinking_delta', turnId, text, partial: true },
          { kind: 'thinking_end', turnId, totalTokens: text.length },
        ];
      }
      case 'commandExecution': {
        const ok = item.status !== 'failed';
        return [{
          kind: 'tool_use_result',
          toolUseId: String(item.id),
          output: item.output ?? item.stdout ?? '',
          durationMs: Number((item.durationMs as number | undefined) ?? 0),
          ok,
        }];
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path: string; kind: string }>) : [];
        const events: NotificationEvent[] = [];
        for (const c of changes) {
          const op: 'created' | 'modified' | 'deleted' =
            c.kind === 'add' ? 'created' : c.kind === 'delete' ? 'deleted' : 'modified';
          events.push({ kind: 'file_changed', path: c.path, op });
        }
        return events;
      }
      case 'plan': {
        // Codex planning items don't map cleanly; surface the description as
        // a final assistant_text so renderers still show the content.
        const description = String(item.text ?? '');
        return description
          ? [{ kind: 'assistant_text', turnId, text: description, complete: true }]
          : [];
      }
      case 'mcpToolCall': {
        const ok = item.status !== 'failed';
        return [{
          kind: 'tool_use_result',
          toolUseId: String(item.id),
          output: item.result ?? {},
          durationMs: Number((item.durationMs as number | undefined) ?? 0),
          ok,
        }];
      }
      case 'webSearch': {
        const query = String(item.query ?? '');
        return query
          ? [{ kind: 'assistant_text', turnId, text: `Searched: ${query}`, complete: true }]
          : [];
      }
      default:
        return [];
    }
  }

  private extractUsage(raw: unknown): TokenUsageSummary {
    const r = raw as
      | {
          last?: {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheCreationTokens?: number;
            costUsd?: number;
          };
        }
      | undefined;
    return {
      inputTokens: r?.last?.inputTokens ?? 0,
      outputTokens: r?.last?.outputTokens ?? 0,
      cacheReadTokens: r?.last?.cacheReadTokens,
      cacheCreationTokens: r?.last?.cacheCreationTokens,
      costUsd: r?.last?.costUsd,
    };
  }
}
