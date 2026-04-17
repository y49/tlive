import type { CanonicalEvent } from '../../messages/schema.js';

interface ThreadItem {
  id: string;
  type: string;
  [k: string]: unknown;
}

interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
}

export class CodexEventAdapter {
  private threadId: string | null = null;
  private recentItems = new Map<string, ThreadItem>();
  private pendingAgentText = new Map<string, string>();
  private tokenUsage: TokenUsageSummary | null = null;

  handle(method: string, params: unknown): CanonicalEvent[] {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'thread/started':
        this.threadId = ((p.thread as any)?.id ?? null) as string | null;
        return [];
      case 'thread/tokenUsage/updated':
        this.tokenUsage = this.extractUsage(p.tokenUsage);
        return [];
      case 'turn/started':
        return [{ kind: 'status', sessionId: this.threadId ?? '', model: '' }];
      case 'turn/completed':
        return this.handleTurnCompleted(p);
      case 'item/started':
        return this.handleItemStarted(p);
      case 'item/completed':
        return this.handleItemCompleted(p);
      case 'error':
        return [{ kind: 'error', message: String(p.message ?? 'Unknown error') }];
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
        return [];
      default:
        return [];
    }
  }

  getItem(itemId: string): ThreadItem | undefined {
    return this.recentItems.get(itemId);
  }

  reset(): void {
    this.threadId = null;
    this.recentItems.clear();
    this.pendingAgentText.clear();
    this.tokenUsage = null;
  }

  private handleTurnCompleted(p: Record<string, unknown>): CanonicalEvent[] {
    const turn = p.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
    const status = turn?.status ?? 'completed';
    const sessionId = this.threadId ?? '';
    const usage = this.tokenUsage ?? (() => {
      console.warn(`[codex-event-adapter] turn/completed without prior tokenUsage (thread: ${sessionId})`);
      return { inputTokens: 0, outputTokens: 0 };
    })();
    // Clear items + tokenUsage at turn boundary
    this.recentItems.clear();
    this.pendingAgentText.clear();
    this.tokenUsage = null;
    if (status === 'failed') {
      return [
        { kind: 'query_result', sessionId, isError: true, usage },
        { kind: 'error', message: turn?.error?.message ?? 'Codex turn failed' },
      ];
    }
    return [{ kind: 'query_result', sessionId, isError: false, usage }];
  }

  private handleItemStarted(p: Record<string, unknown>): CanonicalEvent[] {
    const item = p.item as ThreadItem | undefined;
    if (item && item.id) this.recentItems.set(item.id, item);
    return [];
  }

  private handleItemCompleted(p: Record<string, unknown>): CanonicalEvent[] {
    const item = p.item as ThreadItem | undefined;
    if (!item) return [];
    // Refresh cache with final item state (completed items have full data)
    if (item.id) this.recentItems.set(item.id, item);
    switch (item.type) {
      case 'agentMessage': {
        const text = (item.text as string) ?? '';
        return [{ kind: 'text_delta', text }];
      }
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? (item.summary as string[]).filter(Boolean) : [];
        const content = Array.isArray(item.content) ? (item.content as string[]).filter(Boolean) : [];
        const text = [...summary, ...content].join('\n\n');
        return [{ kind: 'reasoning_complete', text }];
      }
      case 'commandExecution': {
        const input = { command: (item.command as string) ?? '', cwd: (item.cwd as string) ?? '' };
        const exitCode = item.exitCode as number | null;
        const output = (item.aggregatedOutput as string) ?? '';
        return [
          { kind: 'tool_start', id: String(item.id), name: 'Bash', input },
          {
            kind: 'tool_result',
            toolUseId: String(item.id),
            content: output,
            isError: typeof exitCode === 'number' && exitCode !== 0,
          },
        ];
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
        return [{ kind: 'agent_progress', description }];
      }
      case 'mcpToolCall': {
        const server = (item.server as string) ?? '?';
        const tool = (item.tool as string) ?? '?';
        const args = (item.arguments as Record<string, unknown>) ?? {};
        const result = (item.result as string | undefined) ?? '';
        const errorMsg = (item.error as string | undefined);
        return [
          { kind: 'tool_start', id: String(item.id), name: `MCP:${server}.${tool}`, input: args },
          {
            kind: 'tool_result',
            toolUseId: String(item.id),
            content: errorMsg ?? result,
            isError: !!errorMsg,
          },
        ];
      }
      case 'webSearch': {
        const query = (item.query as string) ?? '';
        return [{ kind: 'agent_progress', description: `Searched: ${query}` }];
      }
      default: {
        return [{ kind: 'agent_progress', description: `[codex:${String(item.type)}]` }];
      }
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
