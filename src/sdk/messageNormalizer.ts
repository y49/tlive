// src/sdk/messageNormalizer.ts
import type { NormalizedMessage } from './providerAdapter.js';

export interface RawSessionLine {
  uuid: string;
  type: string;
  message: unknown;
  [key: string]: unknown;
}

/**
 * Extract content blocks from a message.
 * Claude .jsonl format: { message: { role: "assistant", content: [...] } }
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
        messages.push({ kind: 'tool_use', provider, sessionId, toolName: block.name as string, toolInput: block.input });
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

/** Formats a NormalizedMessage for IM display (plain text summary). */
export function formatForIM(msg: NormalizedMessage): string {
  switch (msg.kind) {
    case 'text': return msg.text ?? '';
    case 'tool_use': return `🔧 ${msg.toolName}${formatToolArgs(msg.toolName, msg.toolInput)}`;
    case 'tool_result': return ''; // Skip tool results in IM sync (too noisy)
    case 'permission_request': return `⚠️ Permission: ${msg.toolName}\n${formatToolArgs(msg.toolName, msg.toolInput)}`;
    case 'error': return `❌ ${msg.text}`;
    case 'complete': return '✅ Session complete';
    case 'status': return `ℹ️ ${msg.text}`;
    default: return '';
  }
}

/**
 * Format tool arguments for IM display.
 * Adapted from hapi's formatToolArgumentsDetailed — show relevant args per tool type.
 */
function formatToolArgs(toolName: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object' || !toolName) return '';
  const args = input as Record<string, unknown>;
  const MAX = 150;

  switch (toolName) {
    case 'Bash':
      return args.command ? `\n\`${truncate(String(args.command), MAX)}\`` : '';
    case 'Read':
      return args.file_path ? `\n${truncate(String(args.file_path), MAX)}` : '';
    case 'Edit':
    case 'Write': {
      const file = args.file_path ?? args.path ?? '';
      return file ? `\n${truncate(String(file), MAX)}` : '';
    }
    case 'Grep':
    case 'Glob': {
      const pattern = args.pattern ?? '';
      return pattern ? ` \`${truncate(String(pattern), 80)}\`` : '';
    }
    case 'WebFetch':
      return args.url ? `\n${truncate(String(args.url), MAX)}` : '';
    case 'Agent':
      return args.prompt ? `\n${truncate(String(args.prompt), MAX)}` : '';
    case 'AskUserQuestion':
      return args.question ? `\n${truncate(String(args.question), MAX)}` : '';
    default: {
      // Generic: show first string-valued arg
      for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.length > 0) {
          return `\n${truncate(v, MAX)}`;
        }
      }
      return '';
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
