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
    case 'tool_use': return `🔧 ${msg.toolName}`;
    case 'tool_result': return `✅ Result`;
    case 'permission_request': return `⚠️ Permission: ${msg.toolName}\n${summarizeInput(msg.toolInput)}`;
    case 'error': return `❌ ${msg.text}`;
    case 'complete': return '✅ Session complete';
    case 'status': return `ℹ️ ${msg.text}`;
    default: return '';
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (obj.command) return `\`${truncate(String(obj.command), 200)}\``;
  if (obj.file_path) return `\`${obj.file_path}\``;
  if (obj.path) return `\`${obj.path}\``;
  if (obj.pattern) return `\`${obj.pattern}\``;
  return truncate(JSON.stringify(input), 200);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
