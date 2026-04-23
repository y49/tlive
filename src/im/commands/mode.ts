// src/im/commands/mode.ts
//
// `/mode [<mode>]` — show or change permission mode.

import type { CommandDef } from '../command-parser.js';
import type { PermissionMode } from '../../runtime/types.js';
import { activeLocalSession, workspaceForChat } from './_shared.js';

const VALID_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'default', 'yolo', 'safe-yolo', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions',
]);

export const modeCmd: CommandDef = {
  name: 'mode',
  role: ['admin', 'operator'],
  description: 'Show or change permission mode',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) { await ctx.reply('No workspace bound.'); return; }
    if (args.length === 0) {
      await ctx.reply(`Current mode: ${ws.defaults.permissionMode}`);
      return;
    }
    const newMode = args[0] as PermissionMode;
    if (!VALID_MODES.has(newMode)) {
      await ctx.reply(`Unknown mode '${newMode}'. Valid: ${[...VALID_MODES].join(', ')}`);
      return;
    }
    ws.defaults.permissionMode = newMode;
    await ctx.workspaceManager.save();
    const session = await activeLocalSession(ctx).catch(() => null);
    if (session) await session.setPermissionMode(newMode);
    await ctx.reply(`Permission mode set to ${newMode}.`);
  },
};
