// src/sdk/codexAdapter.ts

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ProviderAdapter,
  ProviderCapabilityFlags,
  NormalizedMessage,
  SpawnOptions,
  RemoteOptions,
  ThinkingTriggerEvent,
} from './providerAdapter.js';
import type { NotificationEvent } from './sharedEvents.js';
import type { ScannerContextSnapshot } from '../core/scannerContext.js';
import type { ToolUseEvent } from '../core/sessionScanner.js';

export class CodexAdapter implements ProviderAdapter {
  name = 'codex' as const;
  capabilities: ProviderCapabilityFlags = { liveSession: false };
  private executablePath: string | null = null;

  async resolveExecutable(): Promise<string> {
    if (this.executablePath) return this.executablePath;
    if (process.env.TLIVE_CODEX_EXECUTABLE) {
      this.executablePath = process.env.TLIVE_CODEX_EXECUTABLE;
      return this.executablePath;
    }
    try {
      this.executablePath = execSync('which codex', {
        encoding: 'utf-8',
      }).trim();
    } catch {
      this.executablePath = 'codex';
    }
    return this.executablePath;
  }

  getSessionIdArgs(_sessionId: string): string[] {
    // Codex CLI assigns its own session id; we detect it via scanner.
    return [];
  }

  getResumeArgs(sessionId: string): string[] {
    return ['--resume', sessionId];
  }

  spawnArgs(opts: SpawnOptions): string[] {
    return opts.args ? [...opts.args] : [];
  }

  async *startRemote(
    _opts: RemoteOptions,
  ): AsyncIterable<NormalizedMessage> {
    throw new Error('Codex remote SDK path not implemented in terminal mode');
  }

  getSessionDir(_workdir: string): string {
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    return join(codexHome, 'sessions');
  }

  normalizeSessionEvent(event: unknown, ctx?: { sessionId?: string }): NormalizedMessage[] {
    const e = event as { type?: string; payload?: Record<string, unknown> };
    const sessionId = ctx?.sessionId ?? '';

    if (e.type === 'session_meta' || e.type === 'turn_context') return [];

    if (e.type === 'response_item') {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const ptype = p.type;

      if (ptype === 'message' && p.role === 'assistant') {
        const content = Array.isArray(p.content) ? p.content : [];
        const firstText = content.find((c: any) => c?.type === 'output_text' || c?.type === 'text')?.text;
        if (typeof firstText === 'string' && firstText.length > 0) {
          // Some models (gpt-oss, minimax-m2.5) emit reasoning followed by a
          // closing </think> tag in the assistant text — the opening <think>
          // already lives in a separate `reasoning` item. Drop everything up
          // to and including the first </think> so only the answer surfaces.
          const closeIdx = firstText.indexOf('</think>');
          const cleaned = closeIdx >= 0
            ? firstText.slice(closeIdx + '</think>'.length).trim()
            : firstText;
          if (cleaned.length === 0) return [];
          return [{ kind: 'text', text: cleaned, provider: 'codex', sessionId }];
        }
        return [];
      }

      if (ptype === 'function_call') {
        const toolName = typeof p.name === 'string' ? p.name : 'unknown';
        const toolUseId = typeof p.call_id === 'string' ? p.call_id : '';
        let toolInput: unknown = p.arguments;
        if (typeof toolInput === 'string') {
          try { toolInput = JSON.parse(toolInput); } catch { /* keep as string */ }
        }
        return [{
          kind: 'tool_use',
          toolName,
          toolUseId,
          toolInput,
          provider: 'codex',
          sessionId,
        }];
      }

      if (ptype === 'function_call_output') {
        const toolUseId = typeof p.call_id === 'string' ? p.call_id : '';
        const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        return [{
          kind: 'tool_result',
          toolUseId,
          text: output,
          provider: 'codex',
          sessionId,
        }];
      }

      // reasoning: content is always null/encrypted in .jsonl — emit nothing (thinking state handled separately)
      return [];
    }

    if (e.type === 'event_msg') {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const ptype = p.type;

      if (ptype === 'task_complete') {
        return [{ kind: 'complete', provider: 'codex', sessionId }];
      }

      return [];
    }

    return [];
  }

  extractThinkingEvents(event: unknown): ThinkingTriggerEvent[] {
    const e = event as { type?: string; payload?: Record<string, unknown> };
    if (e.type === 'event_msg') {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (p.type === 'task_started') return [{ type: 'tool_use', toolUseId: '__codex_task__' }];
      if (p.type === 'task_complete') return [{ type: 'tool_result', toolUseId: '__codex_task__' }];
    }
    if (e.type === 'response_item') {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (p.type === 'reasoning') return [{ type: 'tool_use', toolUseId: '__codex_reasoning__' }];
    }
    return [];
  }

  /**
   * Transform a raw Codex scanner event into zero or more NotificationEvents.
   * Pure: no mutation, no I/O. Defensive: returns [] for unrecognized shapes.
   * Handles </think> split for gpt-oss / minimax-m2.5 style models where the
   * assistant message bundles reasoning prefix + answer in one output_text.
   * No display-concern leaks — bridge decorator owns titles and terminal URLs.
   */
  toEvents(raw: Record<string, unknown>, _ctx: ScannerContextSnapshot): NotificationEvent[] {
    const t = raw.type;
    if (t === 'session_meta' || t === 'turn_context') return [];

    if (t === 'response_item') {
      const p = (raw.payload ?? {}) as Record<string, unknown>;
      const pt = p.type;

      if (pt === 'message' && p.role === 'assistant') {
        const content = Array.isArray(p.content) ? (p.content as Array<Record<string, unknown>>) : [];
        const firstText = content.find(
          (c) => c?.type === 'output_text' || c?.type === 'text',
        )?.text;
        if (typeof firstText !== 'string' || firstText.length === 0) return [];
        const closeIdx = firstText.indexOf('</think>');
        const cleaned = closeIdx >= 0
          ? firstText.slice(closeIdx + '</think>'.length).trim()
          : firstText;
        if (cleaned.length === 0) return [];
        return [{ kind: 'activity_text', text: cleaned }];
      }

      if (pt === 'function_call') {
        const toolName = typeof p.name === 'string' ? p.name : 'unknown';
        const rawArgs = p.arguments;
        // raw JSON string passed through as-is — ProviderAdapter contract keeps
        // toEvents pure and shape-level. normalizeSessionEvent (deleted in Task 6)
        // used to JSON.parse here; bridge decorator / renderers handle display.
        const toolInput = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? '');
        return [{ kind: 'activity_tool', toolName, toolInput }];
      }

      // function_call_output, reasoning → filtered (handled elsewhere / thinking tracker)
      return [];
    }

    // event_msg (token_count, task_complete, task_started): no NotificationEvent here.
    // token_count surfaces via extractUsage; task lifecycle via sessionManager.
    return [];
  }

  /**
   * Pure. Returns token usage object when `raw` is a token_count event; else null.
   * Always returns all three numeric fields (zero-filled) when usage is present.
   * Zero-fill is a contractual guarantee, not a workaround — callers can assume the
   * shape is stable across codex versions even if a field is absent upstream.
   */
  extractUsage(raw: Record<string, unknown>): Record<string, unknown> | null {
    if (raw.type !== 'event_msg') return null;
    const p = (raw.payload ?? {}) as Record<string, unknown>;
    if (p.type !== 'token_count') return null;
    const info = (p.info ?? {}) as Record<string, unknown>;
    const totals = (info.total_token_usage ?? {}) as Record<string, unknown>;
    return {
      input_tokens: typeof totals.input_tokens === 'number' ? totals.input_tokens : 0,
      output_tokens: typeof totals.output_tokens === 'number' ? totals.output_tokens : 0,
      cached_input_tokens: typeof totals.cached_input_tokens === 'number' ? totals.cached_input_tokens : 0,
    };
  }

  /**
   * Codex scanner path has no permission broker — codex CLI owns its own
   * permission TUI. Callers MUST guard with `capabilities.liveSession` check
   * or a try/catch. See ProviderAdapter JSDoc.
   */
  toPermissionEvent(_toolUse: ToolUseEvent, _ctx: ScannerContextSnapshot): NotificationEvent {
    throw new Error('codex scanner path has no permission broker');
  }
}
