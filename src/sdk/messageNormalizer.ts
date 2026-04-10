// src/sdk/messageNormalizer.ts
import type { NormalizedMessage } from './providerAdapter.js';

export interface RawSessionLine {
  uuid: string;
  type: string;
  message: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// .jsonl → NormalizedMessage
// ---------------------------------------------------------------------------

/**
 * Extract content blocks from a Claude .jsonl message.
 * Handles both nested { role, content: [...] } and flat [...] formats.
 */
function getContentBlocks(message: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(message)) return message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) return content;
  }
  return [];
}

/** Normalizes raw .jsonl session lines into NormalizedMessage format. */
export function normalizeSessionLine(
  line: RawSessionLine, provider: 'claude' | 'codex', sessionId: string,
): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const blocks = getContentBlocks(line.message);

  if (line.type === 'assistant') {
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        messages.push({ kind: 'text', provider, sessionId, text: block.text as string });
      } else if (block.type === 'tool_use') {
        messages.push({ kind: 'tool_use', provider, sessionId, toolName: block.name as string, toolInput: block.input, toolUseId: block.id as string });
      }
      // Skip 'thinking' blocks — internal
    }
  }

  if (line.type === 'user') {
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        messages.push({
          kind: 'tool_result', provider, sessionId,
          parentToolUseId: block.tool_use_id as string,
          text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// NormalizedMessage → IM display string
// ---------------------------------------------------------------------------

type IMFormatter = (msg: NormalizedMessage) => string;

import { LABEL } from '../im/icons.js';

/** Registry of formatters keyed by message kind. */
const imFormatters: Record<string, IMFormatter> = {
  text:               (msg) => msg.text ?? '',
  tool_use:           (msg) => `${LABEL.tool} ${msg.toolName}${formatToolArgs(msg.toolName, msg.toolInput)}`,
  tool_result:        ()    => '',
  permission_request: (msg) => `${LABEL.permission}: ${msg.toolName}\n${formatToolArgs(msg.toolName, msg.toolInput)}`,
  error:              (msg) => `${LABEL.error}: ${msg.text}`,
  complete:           ()    => `${LABEL.done}`,
  status:             (msg) => msg.text ?? '',
};

/** Format a NormalizedMessage for IM display. */
export function formatForIM(msg: NormalizedMessage): string {
  const formatter = imFormatters[msg.kind];
  return formatter ? formatter(msg) : '';
}

// ---------------------------------------------------------------------------
// Tool argument formatting — per-tool display strategies
// ---------------------------------------------------------------------------

const MAX_ARG_LEN = 150;

type ToolArgFormatter = (args: Record<string, unknown>) => string;

/** Registry of tool-specific argument formatters. */
const toolArgFormatters: Record<string, ToolArgFormatter> = {
  Bash:            (a) => a.command ? `\n\`${truncate(String(a.command), MAX_ARG_LEN)}\`` : '',
  Read:            (a) => a.file_path ? `\n${truncate(String(a.file_path), MAX_ARG_LEN)}` : '',
  Edit:            (a) => formatFilePath(a),
  Write:           (a) => formatFilePath(a),
  Grep:            (a) => a.pattern ? ` \`${truncate(String(a.pattern), 80)}\`` : '',
  Glob:            (a) => a.pattern ? ` \`${truncate(String(a.pattern), 80)}\`` : '',
  WebFetch:        (a) => a.url ? `\n${truncate(String(a.url), MAX_ARG_LEN)}` : '',
  Agent:           (a) => a.prompt ? `\n${truncate(String(a.prompt), MAX_ARG_LEN)}` : '',
  AskUserQuestion: (a) => a.question ? `\n${truncate(String(a.question), MAX_ARG_LEN)}` : '',
};

/** Fallback: show first non-empty string value from args. */
function defaultToolArgFormatter(args: Record<string, unknown>): string {
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) return `\n${truncate(v, MAX_ARG_LEN)}`;
  }
  return '';
}

function formatToolArgs(toolName: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object' || !toolName) return '';
  const args = input as Record<string, unknown>;
  const formatter = toolArgFormatters[toolName] ?? defaultToolArgFormatter;
  return formatter(args);
}

function formatFilePath(args: Record<string, unknown>): string {
  const file = args.file_path ?? args.path ?? '';
  return file ? `\n${truncate(String(file), MAX_ARG_LEN)}` : '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ---------------------------------------------------------------------------
// NormalizedMessage → StructuredNotificationEvent (for IPC to bridge)
// ---------------------------------------------------------------------------

/**
 * Structured notification event sent via IPC to the bridge.
 * Mirrors bridge/src/renderers/types.ts NotificationEvent shape
 * without cross-package imports.
 */
export interface StructuredNotificationEvent {
  kind: string;
  [key: string]: unknown;
}

/**
 * Convert a NormalizedMessage into a structured notification event.
 * The bridge-side Renderer handles all display formatting.
 */
export function toNotificationEvent(msg: NormalizedMessage): StructuredNotificationEvent | null {
  switch (msg.kind) {
    case 'tool_use': {
      if (msg.toolName === 'AskUserQuestion') {
        const input = (msg.toolInput ?? {}) as Record<string, unknown>;
        return {
          kind: 'ask_user_question',
          question: (input.question as string) ?? '',
          header: input.header as string | undefined,
          options: input.options as unknown[] | undefined,
          toolUseId: msg.parentToolUseId ?? '',
        };
      }
      return {
        kind: 'activity_tool',
        toolName: msg.toolName ?? 'unknown',
        toolInput: formatToolArgsBrief(msg.toolName, msg.toolInput),
      };
    }
    case 'permission_request':
      return {
        kind: 'permission_request',
        toolName: msg.toolName ?? 'unknown',
        toolInput: formatToolArgsBrief(msg.toolName, msg.toolInput),
        permissionId: '',  // assigned by bridge
      };
    case 'text':
      return { kind: 'activity_text', text: msg.text ?? '' };
    case 'error':
      return { kind: 'error', message: msg.text ?? 'Unknown error' };
    case 'complete':
      return {
        kind: 'session_complete',
        summary: msg.text ?? '',
      };
    default:
      return null;
  }
}

/**
 * Brief tool argument summary for IPC — the bridge-side Renderer handles display formatting.
 * Unlike formatToolArgs(), this produces clean one-liners without backtick wrapping or \n prefixes.
 */
export function formatToolArgsBrief(toolName: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object' || !toolName) return '';
  const args = input as Record<string, unknown>;
  if (toolName === 'Bash') return (args.command as string) ?? '';
  if (toolName === 'Read') return (args.file_path as string) ?? '';
  if (toolName === 'Edit' || toolName === 'Write') return (args.file_path as string) ?? '';
  if (toolName === 'Grep') return (args.pattern as string) ?? '';
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 200);
  }
  return '';
}

// ---------------------------------------------------------------------------
// TodoWrite extraction
// ---------------------------------------------------------------------------

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export function extractTodos(toolInput: unknown): TodoItem[] | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  const todos = input.todos;
  if (!Array.isArray(todos)) return null;
  return todos.map(t => ({
    content: (t as any).content ?? (t as any).subject ?? String(t),
    status: (t as any).status ?? 'pending',
  }));
}

export function formatTodos(todos: TodoItem[]): string {
  const marks: Record<string, string> = {
    completed: '[x]', in_progress: '[-]', pending: '[ ]',
  };
  return todos.map(t => `${marks[t.status] ?? '[ ]'} ${t.content}`).join('\n');
}
