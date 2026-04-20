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
}
