// src/permission/categories/file-edit.ts
//
// Render shape for `file-edit`-category PermissionRequests (Edit / Write /
// NotebookEdit / MultiEdit). Emits a minimal unified diff so the IM
// renderer can wrap it in a ``` block. Uses the `diffPreview` the runtime
// already attached (see categorize.ts); when absent, computes a simple
// line-count summary from tool input directly.

import type { PermissionRequest } from '../../runtime/types.js';

export interface FileEditRenderData {
  kind: 'file-edit';
  toolName: string;
  path: string;
  from: string;
  to: string;
  added: number;
  removed: number;
  /** Unified-diff text — `- oldline` / `+ newline` format. No @@ hunks. */
  unifiedDiff: string;
}

export function render(req: PermissionRequest): FileEditRenderData {
  const input = (req.toolInput ?? {}) as Record<string, unknown>;
  const path = String(
    req.diffPreview?.path ??
      input.file_path ??
      input.path ??
      '',
  );
  const from = String(req.diffPreview?.from ?? input.old_string ?? input.old_str ?? '');
  const to = String(
    req.diffPreview?.to ?? input.new_string ?? input.new_str ?? input.content ?? '',
  );
  const added = req.diffPreview?.added ?? countAdded(from, to);
  const removed = req.diffPreview?.removed ?? countRemoved(from);

  return {
    kind: 'file-edit',
    toolName: req.toolName,
    path,
    from,
    to,
    added,
    removed,
    unifiedDiff: toUnifiedDiff(from, to),
  };
}

function countRemoved(from: string): number {
  return from ? from.split('\n').length : 0;
}

function countAdded(from: string, to: string): number {
  const fromLines = from ? from.split('\n').length : 0;
  const toLines = to ? to.split('\n').length : 0;
  return Math.max(0, toLines - fromLines);
}

/**
 * Minimal unified-diff-style text: every `from` line becomes `- <line>` and
 * every `to` line becomes `+ <line>`. No LCS alignment — this is a UI hint,
 * not a merge tool. Empty `from`/`to` safely produces a pure-add or pure-
 * remove block.
 */
function toUnifiedDiff(from: string, to: string): string {
  const fromLines = from ? from.split('\n') : [];
  const toLines = to ? to.split('\n') : [];
  const lines: string[] = [];
  for (const line of fromLines) lines.push(`- ${line}`);
  for (const line of toLines) lines.push(`+ ${line}`);
  return lines.join('\n');
}
