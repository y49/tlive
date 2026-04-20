// src/sdk/claudeAdapter.ts

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ProviderAdapter,
  ProviderCapabilityFlags,
  NormalizedMessage,
  SpawnOptions,
  RemoteOptions,
  ThinkingTriggerEvent,
} from './providerAdapter.js';
import { findLastSession } from '../core/sessionDiscovery.js';
import { normalizeSessionLine, formatToolArgsBrief, extractTodos } from './messageNormalizer.js';
import type { NotificationEvent } from './sharedEvents.js';
import type { ScannerContextSnapshot } from '../core/scannerContext.js';
import type { ToolUseEvent } from '../core/sessionScanner.js';

/**
 * Extract content blocks from a Claude .jsonl message.
 * Claude format: { message: { role: "assistant", content: [...] } } or flat [...].
 */
function getContentBlocks(message: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(message)) return message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) return content;
  }
  return [];
}

/**
 * Parse AskUserQuestion option list into the shared NotificationEvent option shape.
 * Returns [] when the input has no options array.
 */
function parseAskOptions(firstQ: Record<string, unknown>): Array<{ label: string; description?: string }> {
  const rawOpts = Array.isArray(firstQ.options)
    ? (firstQ.options as Array<Record<string, unknown>>)
    : [];
  return rawOpts.map((o) => ({
    label: (o.label as string) ?? (o.description as string) ?? '?',
    ...(o.description ? { description: o.description as string } : {}),
  }));
}

export class ClaudeAdapter implements ProviderAdapter {
  name = 'claude' as const;
  capabilities: ProviderCapabilityFlags = { liveSession: true };
  private executablePath: string | null = null;

  async resolveExecutable(): Promise<string> {
    if (this.executablePath) return this.executablePath;
    if (process.env.CTI_CLAUDE_CODE_EXECUTABLE) {
      this.executablePath = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
      return this.executablePath;
    }
    try {
      this.executablePath = execSync('which claude', {
        encoding: 'utf-8',
      }).trim();
    } catch {
      this.executablePath = 'claude';
    }
    return this.executablePath;
  }

  getSessionIdArgs(sessionId: string): string[] {
    return ['--session-id', sessionId];
  }

  getResumeArgs(sessionId: string): string[] {
    return ['--resume', '--session-id', sessionId];
  }

  spawnArgs(opts: SpawnOptions): string[] {
    const args = [...this.getSessionIdArgs(opts.sessionId)];
    if (opts.args) args.push(...opts.args);
    return args;
  }

  async *startRemote(
    _opts: RemoteOptions,
  ): AsyncIterable<NormalizedMessage> {
    // SDK integration will be wired in later when we have the real SDK dependency.
    // For now this is the interface contract.
    throw new Error(
      'startRemote requires Claude Agent SDK — wire in integration task',
    );
  }

  getSessionDir(workdir: string): string {
    const projectDir = resolve(workdir).replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectDir);
  }

  findLastSession(workdir: string): string | null {
    return findLastSession(workdir);
  }

  normalizeSessionEvent(event: unknown, ctx?: { sessionId?: string }): NormalizedMessage[] {
    const e = event as { uuid?: string; type?: string; message?: unknown };
    if (!e.uuid || !e.type) return [];
    return normalizeSessionLine(
      { uuid: e.uuid, type: e.type, message: e.message },
      'claude',
      ctx?.sessionId ?? '',
    );
  }

  /**
   * Transform a raw Claude scanner event into zero or more NotificationEvents.
   * Pure: no mutation, no I/O. Defensive: returns [] for unrecognized shapes.
   * No display-concern leaks — the bridge decorator owns titles/URLs.
   */
  toEvents(raw: Record<string, unknown>, _ctx: ScannerContextSnapshot): NotificationEvent[] {
    const type = raw.type;
    const blocks = getContentBlocks((raw as { message?: unknown }).message);
    const out: NotificationEvent[] = [];

    if (type === 'assistant') {
      for (const block of blocks) {
        const bt = block.type;
        if (bt === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          out.push({ kind: 'activity_text', text: block.text });
        } else if (bt === 'tool_use') {
          const toolName = typeof block.name === 'string' ? block.name : 'unknown';
          const toolUseId = typeof block.id === 'string' ? block.id : '';
          const input = block.input as Record<string, unknown> | undefined;

          if (toolName === 'AskUserQuestion') {
            const questions = Array.isArray(input?.questions)
              ? (input!.questions as Array<Record<string, unknown>>)
              : [];
            const firstQ: Record<string, unknown> = questions[0] ?? {};
            const options = parseAskOptions(firstQ);
            out.push({
              kind: 'ask_user_question',
              question: (firstQ.question as string) ?? '',
              ...(firstQ.header ? { header: firstQ.header as string } : {}),
              ...(options.length > 0 ? { options } : {}),
              toolUseId,
            });
            continue;
          }

          if (toolName === 'TodoWrite') {
            const todos = extractTodos(input);
            if (todos) {
              out.push({ kind: 'todo_update', items: todos });
              continue;
            }
          }

          out.push({
            kind: 'activity_tool',
            toolName,
            toolInput: formatToolArgsBrief(toolName, input),
          });
        }
        // thinking blocks: skip (internal)
      }
    }
    // type === 'user' with tool_result: filtered (no IM emission)
    return out;
  }

  /**
   * Build a NotificationEvent from a delayed permission_needed ToolUseEvent.
   * Pure. AskUserQuestion tool → ask_user_question kind; all others → permission_request.
   */
  toPermissionEvent(toolUse: ToolUseEvent, _ctx: ScannerContextSnapshot): NotificationEvent {
    if (toolUse.toolName === 'AskUserQuestion') {
      const rawInput = toolUse.input as Record<string, unknown> | undefined;
      const questions = Array.isArray(rawInput?.questions)
        ? (rawInput!.questions as Array<Record<string, unknown>>)
        : [];
      const firstQ: Record<string, unknown> = questions[0] ?? {};
      const options = parseAskOptions(firstQ);
      return {
        kind: 'ask_user_question',
        question: toolUse.questionText ?? (firstQ.question as string) ?? 'Question from Claude',
        ...(options.length > 0 ? { options } : {}),
        toolUseId: toolUse.toolUseId,
      };
    }
    return {
      kind: 'permission_request',
      toolName: toolUse.toolName,
      toolInput: formatToolArgsBrief(toolUse.toolName, toolUse.input),
      permissionId: toolUse.toolUseId,
    };
  }

  /**
   * Map a Claude scanner event (`{ type, message, ... }`) into neutral
   * thinking-tracker triggers. Behavior-equivalent to the former inline
   * block-walking logic in SessionManager.
   */
  extractThinkingEvents(event: unknown): ThinkingTriggerEvent[] {
    const e = event as { type?: string; message?: unknown };
    const blocks = getContentBlocks(e.message);
    const out: ThinkingTriggerEvent[] = [];
    if (e.type === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.id) {
          out.push({ type: 'tool_use', toolUseId: block.id as string });
        } else if (block.type === 'text') {
          out.push({ type: 'text' });
        }
      }
    } else if (e.type === 'user') {
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          out.push({ type: 'tool_result', toolUseId: block.tool_use_id as string });
        }
      }
    }
    return out;
  }
}
