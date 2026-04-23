// src/permission/categories/exec.ts
//
// Render shape for `exec`-category PermissionRequests (Bash / BashOutput /
// KillShell). Consumed by T6's PermissionCardRenderer to draw an IM card.
// The underlying risk heuristic + toolName classification are shared with
// `src/runtime/claude/categorize.ts`; this file reuses it so adding new
// exec tools only needs one edit.

import type { PermissionRequest } from '../../runtime/types.js';
import { categorizeClaudeToolUse } from '../../runtime/claude/categorize.js';

export interface ExecRenderData {
  kind: 'exec';
  toolName: string;
  command: string;
  cwd?: string;
  risk: 'low' | 'medium' | 'high';
}

export function render(req: PermissionRequest): ExecRenderData {
  const input = (req.toolInput ?? {}) as Record<string, unknown>;
  const command = String(input.command ?? '');
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  return {
    kind: 'exec',
    toolName: req.toolName,
    command,
    cwd,
    risk: req.risk ?? deriveRisk(command),
  };
}

/** Fall-back risk heuristic when the runtime didn't tag `req.risk`. */
function deriveRisk(command: string): 'low' | 'medium' | 'high' {
  const { risk } = categorizeClaudeToolUse('Bash', { command });
  return risk ?? 'low';
}
