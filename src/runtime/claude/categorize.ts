// src/runtime/claude/categorize.ts
//
// Classify Claude tool_use calls into permission categories + risk heuristics.
// Pure: no I/O. Used by permission-handler to enrich PermissionRequest.

import type { PermissionRequest } from '../types.js';

const EXEC_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

export function categorizeClaudeToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
): {
  category: PermissionRequest['category'];
  diffPreview?: PermissionRequest['diffPreview'];
  risk?: PermissionRequest['risk'];
} {
  if (EXEC_TOOLS.has(toolName)) {
    const cmd = String(toolInput.command ?? '');
    const risk = /\b(rm\s+-rf|sudo|curl.*\|\s*sh|chmod\s+777)\b/.test(cmd) ? 'high'
      : /\b(rm|mv|chmod|chown|kill)\b/.test(cmd) ? 'medium'
      : 'low';
    return { category: 'exec', risk };
  }
  if (EDIT_TOOLS.has(toolName)) {
    const from = String(toolInput.old_string ?? toolInput.old_str ?? '');
    const to = String(toolInput.new_string ?? toolInput.new_str ?? toolInput.content ?? '');
    const toLines = to ? to.split('\n').length : 0;
    const fromLines = from ? from.split('\n').length : 0;
    const added = Math.max(0, toLines - fromLines);
    const removed = fromLines;
    return {
      category: 'file-edit',
      diffPreview: {
        from,
        to,
        added,
        removed,
        path: String(toolInput.file_path ?? toolInput.path ?? ''),
      },
      risk: 'medium',
    };
  }
  return { category: 'generic', risk: 'low' };
}
