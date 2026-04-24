// src/im/commands/export.ts
//
// `/export <alias> [md|json|jsonl]` — export a session's message history.
// Reads the session jsonl via ctx.persistence (wired by daemon bootstrap)
// and formats it through session/export.ts formatExport.

import type { CommandDef } from '../command-parser.js';
import { resolveSessionArg } from './_shared.js';
import { formatExport, type ExportFormat, type ExportableMessage } from '../../session/export.js';
import type { NotificationEvent } from '../../runtime/events.js';

export const exportCmd: CommandDef = {
  name: 'export',
  role: ['admin', 'operator'],
  description: 'Export a session to md/json/jsonl',
  async run(ctx, args) {
    const [alias, formatRaw] = args;
    if (!alias) { await ctx.reply('Usage: /export <alias> [md|json|jsonl]'); return; }
    const target = await resolveSessionArg(ctx, alias);
    if (!target) return;
    const format: ExportFormat =
      formatRaw === 'json' || formatRaw === 'jsonl' || formatRaw === 'md'
        ? formatRaw
        : 'md';
    if (!ctx.persistence) {
      await ctx.reply(`/export ${target.shortAlias}: persistence not wired.`);
      return;
    }
    const history = await ctx.persistence.loadHistory(target.id).catch(() => [] as NotificationEvent[]);
    const messages: ExportableMessage[] = history.map(eventToMessage).filter((m): m is ExportableMessage => m !== null);
    const meta = { sdkSessionId: target.id, title: target.title, workdir: target.workdir };
    const body = formatExport(messages, format, meta);
    // Clamp for chat — 3 KB preview; full export is on disk if needed.
    const preview = body.length > 3000 ? body.slice(0, 3000) + '…' : body;
    await ctx.reply(`Export (${format}) for ${target.shortAlias}:\n\n${preview}`);
  },
};

function eventToMessage(ev: NotificationEvent): ExportableMessage | null {
  switch (ev.kind) {
    case 'assistant_text':
      return { role: 'assistant', text: ev.text };
    case 'turn_start':
      return { role: 'user', text: ev.userInputPreview };
    case 'tool_use_start':
      return { role: 'tool', toolName: ev.toolName, data: ev.input };
    default:
      return null;
  }
}
