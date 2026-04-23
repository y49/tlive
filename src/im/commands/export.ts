// src/im/commands/export.ts
//
// `/export <alias> [md|json|jsonl]` — export a session's message history.
// TODO(T9): resolve the real jsonl path and stream through
// session/export.ts formatExport. This minimal version confirms the
// request shape and reports what it would export.

import type { CommandDef } from '../command-parser.js';
import { resolveSessionArg } from './_shared.js';
import type { ExportFormat } from '../../session/export.js';

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
    // TODO(T9): attach persistence + formatExport to ctx so we can read the
    // actual jsonl. For now render a pointer.
    await ctx.reply(`Would export ${target.shortAlias} → ${format}. (TODO T9: attach formatter.)`);
  },
};
