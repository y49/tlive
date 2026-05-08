// src/im/commands/think.ts
//
// `/think [<level>]` — show or switch thinking visibility for new sessions.
// (Was `/thinking` pre-v3.3 — alias preserved for typed muscle memory.)
// Per spec §3:
//   no-args  → current level + 3 button picker (collapsed / expanded /
//              hidden) with ✅ on current
//   <level>  → persist as workspace default; new sessions inherit it.
//
// There is no live session-level setter for thinking visibility — the runtime
// reads it from the workspace default at session-create time. So this command
// only writes ws.defaults.thinking.
//
// Callback handlers (runtime:think:set:<l>) are wired in callback-router.ts.

import type { CommandDef, CommandContext } from '../command-parser.js';
import type { ThinkingLevel } from '../../runtime/types.js';
import { workspaceForChat } from './_shared.js';
import { renderPicker } from '../picker/picker.js';

const LEVELS: ThinkingLevel[] = ['collapsed', 'expanded', 'hidden'];
const VALID: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>(LEVELS);

const PICKER_ITEMS = LEVELS.map((l) => ({
  label: l,
  value: l,
}));

export const thinkCmd: CommandDef = {
  name: 'think',
  aliases: ['thinking'],
  description: '思考深度',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个');
      return;
    }
    if (args.length === 0) {
      await showThinkPicker(ctx);
      return;
    }
    const level = args[0] as ThinkingLevel;
    if (!VALID.has(level)) {
      await ctx.reply(`无效 '${level}'。可选: ${LEVELS.join(', ')}`);
      return;
    }
    ws.defaults.thinking = level;
    await ctx.workspaceManager.save();
    await ctx.reply(`✅ 思考深度: ${level}`);
  },
};

async function showThinkPicker(ctx: CommandContext): Promise<void> {
  const ws = workspaceForChat(ctx);
  if (!ws) return;
  const current: ThinkingLevel = ws.defaults.thinking ?? 'collapsed';

  await renderPicker(ctx, {
    title: `🧠 选择思考深度 (workspace 默认)\n当前: ${current}`,
    items: PICKER_ITEMS.map((it) => ({
      ...it,
      marker: it.value === current ? '✅' : undefined,
    })),
    callbackPrefix: 'runtime:think:set',
  });
}
