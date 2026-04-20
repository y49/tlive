// src/sdk/messageNormalizer.ts
// Small utilities shared by provider adapters (tool-arg summary, todo extraction).
// The legacy per-kind IM-formatting / jsonl-normalization pipeline was removed
// in the scanner refactor — adapters now produce NotificationEvent directly.

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

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export function extractTodos(toolInput: unknown): TodoItem[] | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  const todos = input.todos;
  if (!Array.isArray(todos)) return null;
  return todos.map((t) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: (t as any).content ?? (t as any).subject ?? String(t),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    status: (t as any).status ?? 'pending',
  }));
}
