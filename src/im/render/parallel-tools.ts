// src/im/render/parallel-tools.ts
//
// Parallel-tool batch layout helper (spec §7.3). When a turn runs multiple
// tools concurrently the activity sticky shows each one on its own row with
// a progress glyph, so users can see which tool of a batch is still running.
// Emitted as a text block embedded in the activity sticky.

export type ParallelToolStatus = 'running' | 'done_ok' | 'done_err';

export interface ParallelToolEntry {
  toolUseId: string;
  toolName: string;
  status: ParallelToolStatus;
  batchIndex?: number;
}

export function parallelToolGlyph(status: ParallelToolStatus): string {
  switch (status) {
    case 'running': return '🔧';
    case 'done_ok': return '✅';
    case 'done_err': return '❌';
  }
}

export interface ParallelToolSummary {
  total: number;
  completed: number;
  failed: number;
  running: number;
}

export function summarizeParallel(entries: readonly ParallelToolEntry[]): ParallelToolSummary {
  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const e of entries) {
    if (e.status === 'done_ok') completed++;
    else if (e.status === 'done_err') { failed++; completed++; }
    else running++;
  }
  return { total: entries.length, completed, failed, running };
}

/**
 * Render a stable multi-line block. Entries are sorted by batchIndex when
 * present so layout is deterministic across re-renders.
 */
export function renderParallelBlock(entries: readonly ParallelToolEntry[]): string {
  if (entries.length === 0) return '';
  const sorted = [...entries].sort((a, b) => {
    const ai = a.batchIndex ?? 0;
    const bi = b.batchIndex ?? 0;
    return ai - bi;
  });
  const summary = summarizeParallel(sorted);
  const header = `⏳ ${summary.completed}/${summary.total} tools`;
  const lines = sorted.map((e) => `  ${parallelToolGlyph(e.status)} ${e.toolName}`);
  return [header, ...lines].join('\n');
}
