// src/im/render/subagent-nested.ts
//
// Sub-agent nested-line helper (spec §7.3). When the top-level turn spawns
// sub-agents (Task tool) the activity sticky inlines one row per active
// sub-agent so the user sees the tree rather than a single "thinking…" blob.
// Emits the rendered block as a string that ActivityStickyRenderer splices in.

export interface SubagentEntry {
  agentId: string;
  /** Truncated description supplied by subagent_start. */
  description: string;
  /** Latest summary pushed by subagent_progress, if any. */
  latestSummary?: string;
  /** True once subagent_stop fires. */
  done: boolean;
  /** ok flag from subagent_stop; null when still running. */
  ok: boolean | null;
  /** Optional depth for nested sub-agents (0 = child of primary turn). */
  depth?: number;
}

export function subagentGlyph(e: SubagentEntry): string {
  if (!e.done) return '🤖';
  return e.ok ? '✅' : '❌';
}

/**
 * One line per active sub-agent. Completed sub-agents are retained so users
 * see the final result, but collapsed to a short form.
 */
export function renderSubagentBlock(entries: readonly SubagentEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) => {
    const indent = '  '.repeat((e.depth ?? 0) + 1);
    const tail = e.latestSummary ? ` — ${truncate(e.latestSummary, 60)}` : '';
    return `${indent}${subagentGlyph(e)} ${truncate(e.description, 60)}${tail}`;
  });
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
