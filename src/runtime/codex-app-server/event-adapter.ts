// src/runtime/codex-app-server/event-adapter.ts
//
// Maps codex-app-server notifications to NotificationEvent frames.
// The bridge copy's mapping targets were CanonicalEvent; this copy produces
// the unified AdaptedFrame { events: NotificationEvent[]; usage?; isSessionEnd? }
// matching claude-event-adapter's shape.

import type { NotificationEvent, UsageStats } from '../events.js';

export interface AdaptedFrame {
  events: NotificationEvent[];
  usage?: UsageStats;
  isSessionEnd?: boolean;
}

interface ThreadItem {
  id: string;
  type: string;
  [k: string]: unknown;
}

interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  durationMs?: number;
  [k: string]: unknown;
}

export class CodexEventAdapter {
  private threadId: string | null = null;
  private recentItems = new Map<string, ThreadItem>();
  private tokenUsage: TokenUsageSummary | null = null;

  /** Dispatch a codex-app-server JSON-RPC notification and return the frame. */
  handle(method: string, params: unknown): AdaptedFrame {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'thread/started':
        this.threadId = ((p.thread as { id?: string } | undefined)?.id ?? null);
        return { events: [] };
      case 'thread/tokenUsage/updated':
        this.tokenUsage = this.extractUsage(p.tokenUsage);
        return { events: [] };
      case 'turn/started':
        return { events: [] };
      case 'turn/completed':
        return this.handleTurnCompleted(p);
      case 'item/started':
        return this.handleItemStarted(p);
      case 'item/completed':
        return { events: this.handleItemCompleted(p) };
      case 'error':
        return { events: [{ kind: 'error', message: String(p.message ?? 'Unknown error') }] };
      // Deltas + turn-wide aggregates intentionally suppressed (minimal mapping)
      case 'item/agentMessage/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/mcpToolCall/progress':
      case 'item/plan/delta':
      case 'item/commandExecution/terminalInteraction':
      case 'turn/diff/updated':
      case 'turn/plan/updated':
      case 'thread/status/changed':
      case 'thread/closed':
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
  }

  private handleTurnCompleted(p: Record<string, unknown>): AdaptedFrame {
    const turn = p.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
    const status = turn?.status ?? 'completed';
    const usage: UsageStats = {
      inputTokens: this.tokenUsage?.inputTokens ?? 0,
      outputTokens: this.tokenUsage?.outputTokens ?? 0,
      costUsd: this.tokenUsage?.costUsd ?? 0,
      durationMs: this.tokenUsage?.durationMs ?? 0,
    };
    // Clear items + tokenUsage at turn boundary
    this.recentItems.clear();
    this.tokenUsage = null;
    if (status === 'failed') {
      return {
        events: [
          { kind: 'session_complete', summary: '', cost: usage },
          { kind: 'error', message: turn?.error?.message ?? 'Codex turn failed' },
        ],
        usage,
      };
    }
    return {
      events: [{ kind: 'session_complete', summary: '', cost: usage }],
      usage,
    };
  }

  private handleItemStarted(p: Record<string, unknown>): AdaptedFrame {
    const item = p.item as ThreadItem | undefined;
    if (item && item.id) this.recentItems.set(item.id, item);
    return { events: [] };
  }

  private handleItemCompleted(p: Record<string, unknown>): NotificationEvent[] {
    const item = p.item as ThreadItem | undefined;
    if (!item) return [];
    // Refresh cache with final item state (completed items have full data)
    if (item.id) this.recentItems.set(item.id, item);
    switch (item.type) {
      case 'agentMessage': {
        const raw = (item.text as string) ?? '';
        // Some models (gpt-oss family, minimax) embed reasoning inside
        // <think>...</think> markers. Treat everything before the first
        // </think> as reasoning so it renders separately from the answer.
        const events: NotificationEvent[] = [];
        const closeIdx = raw.indexOf('</think>');
        if (closeIdx >= 0) {
          let head = raw.slice(0, closeIdx);
          const openMatch = head.match(/^\s*<think>/);
          if (openMatch) head = head.slice(openMatch[0].length);
          const reasoning = head.trim();
          if (reasoning.length > 0) events.push({ kind: 'reasoning_summary', text: reasoning });
          const tail = raw.slice(closeIdx + '</think>'.length).trim();
          if (tail.length > 0) events.push({ kind: 'activity_text', text: tail });
          if (events.length === 0) events.push({ kind: 'activity_text', text: '' });
          return events;
        }
        return [{ kind: 'activity_text', text: raw }];
      }
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? (item.summary as string[]).filter(Boolean) : [];
        const content = Array.isArray(item.content) ? (item.content as string[]).filter(Boolean) : [];
        const text = [...summary, ...content].join('\n\n');
        return [{ kind: 'reasoning_summary', text }];
      }
      case 'commandExecution': {
        const input = { command: (item.command as string) ?? '', cwd: (item.cwd as string) ?? '' };
        return [{ kind: 'activity_tool', toolName: 'Bash', toolInput: safeStringify(input) }];
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path: string; kind: string }>) : [];
        const mapped = changes.map((c) => ({
          path: c.path,
          kind: (c.kind === 'add' || c.kind === 'delete' || c.kind === 'update' ? c.kind : 'update') as 'add' | 'delete' | 'update',
        }));
        const status = item.status === 'failed' ? 'failed' : 'completed';
        return [{ kind: 'file_change_list', changes: mapped, status }];
      }
      case 'plan': {
        const description = (item.text as string) ?? '';
        return description ? [{ kind: 'activity_text', text: description }] : [];
      }
      case 'mcpToolCall': {
        const server = (item.server as string) ?? '?';
        const tool = (item.tool as string) ?? '?';
        const args = (item.arguments as Record<string, unknown>) ?? {};
        return [{ kind: 'activity_tool', toolName: `MCP:${server}.${tool}`, toolInput: safeStringify(args) }];
      }
      case 'webSearch': {
        const query = (item.query as string) ?? '';
        return [{ kind: 'activity_text', text: `Searched: ${query}` }];
      }
      default:
        return [];
    }
  }

  private extractUsage(raw: unknown): TokenUsageSummary {
    const r = raw as { last?: { inputTokens?: number; outputTokens?: number } } | undefined;
    return {
      inputTokens: r?.last?.inputTokens ?? 0,
      outputTokens: r?.last?.outputTokens ?? 0,
    };
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return '[unserializable]'; }
}
