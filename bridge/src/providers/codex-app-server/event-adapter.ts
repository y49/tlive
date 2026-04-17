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
      case 'error':
        return [{ kind: 'error', message: String(p.message ?? 'Unknown error') }];
      // item/started, item/completed, and deltas handled in next task
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

  private extractUsage(raw: unknown): TokenUsageSummary {
    const r = raw as { last?: { inputTokens?: number; outputTokens?: number } } | undefined;
    return {
      inputTokens: r?.last?.inputTokens ?? 0,
      outputTokens: r?.last?.outputTokens ?? 0,
    };
  }
}
