// src/session/export.ts
//
// Export a session's message history to md / json / jsonl. The IM `/export`
// command calls this; caller supplies the raw jsonl via getSessionMessages
// (SDK helper for Claude) or a direct filesystem read for Codex. Kept I/O-
// free here so tests can assert format output against canned message lists.

export type ExportFormat = 'md' | 'json' | 'jsonl';

export interface ExportableMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text?: string;
  toolName?: string;
  timestamp?: number | string;
  /** Tool output / structured payload. */
  data?: unknown;
}

export function formatExport(
  messages: readonly ExportableMessage[],
  format: ExportFormat,
  meta: { sdkSessionId: string; title?: string; workdir?: string } = { sdkSessionId: 'unknown' },
): string {
  switch (format) {
    case 'json': return JSON.stringify({ meta, messages }, null, 2);
    case 'jsonl': return messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    case 'md': return formatMarkdown(messages, meta);
  }
}

function formatMarkdown(
  messages: readonly ExportableMessage[],
  meta: { sdkSessionId: string; title?: string; workdir?: string },
): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title ?? meta.sdkSessionId}`);
  if (meta.workdir) lines.push(`\n_Workdir: \`${meta.workdir}\`_`);
  lines.push(`\n_Session: \`${meta.sdkSessionId}\`_\n`);
  for (const m of messages) {
    const ts = m.timestamp ? ` · ${new Date(m.timestamp).toISOString()}` : '';
    lines.push(`\n## ${capitalize(m.role)}${ts}\n`);
    if (m.toolName) lines.push(`**Tool:** \`${m.toolName}\`\n`);
    if (m.text) lines.push(m.text);
    if (m.data !== undefined) {
      lines.push('\n```json\n' + JSON.stringify(m.data, null, 2) + '\n```');
    }
  }
  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
