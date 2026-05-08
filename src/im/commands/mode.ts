// src/im/commands/mode.ts
//
// `/mode [<mode>]` — show or switch the current session's permission mode.
// Per spec §3:
//   no-args  → current mode + 4 button picker (default / acceptEdits /
//              bypassPermissions / plan) with ✓ on current
//   <mode>   → setPermissionMode on active session (best effort) + persist
//              as workspace default so new sessions inherit it.
//
// LocalSession does not expose a `permissionMode` getter, so the picker
// reads from the workspace default. When the active session exposes
// `permissionMode` (e.g. test fakes), that wins.
//
// Callback handlers (runtime:mode:set:<m>) are wired in Task 31.

import type { CommandDef, CommandContext } from '../command-parser.js';
import type { ReplyMarkup, InlineButton } from '../../platform/types.js';
import type { PermissionMode } from '../../runtime/types.js';
import type { LocalSession } from '../../session/local-session.js';
import { workspaceForChat } from './_shared.js';

/** Picker shows the four canonical modes; aliases (yolo / safe-yolo /
 *  dontAsk) remain valid arg targets but stay off the keyboard. */
const PICKER_MODES: PermissionMode[] = [
  'default', 'acceptEdits', 'bypassPermissions', 'plan',
];
const VALID_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'default', 'yolo', 'safe-yolo', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions',
]);

export const modeCmd: CommandDef = {
  name: 'mode',
  role: ['admin', 'operator'],
  description: '查看 / 切换权限模式',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个');
      return;
    }
    if (args.length === 0) {
      await renderPicker(ctx);
      return;
    }
    const newMode = args[0] as PermissionMode;
    if (!VALID_MODES.has(newMode)) {
      await ctx.reply(`无效模式 '${newMode}'。可选: ${[...VALID_MODES].join(', ')}`);
      return;
    }
    const session = resolveActiveLocalSilent(ctx);
    if (session) {
      try {
        await session.setPermissionMode(newMode);
      } catch (err) {
        await ctx.reply(`❌ 切换失败: ${(err as Error).message}`);
        return;
      }
    }
    ws.defaults.permissionMode = newMode;
    await ctx.workspaceManager.save();
    await ctx.reply(`✅ 权限模式已切到 ${newMode}`);
  },
};

/**
 * Resolve the workspace's active LocalSession without emitting any reply on
 * miss. Returns null when no session is bound, the session is not in the
 * manager, or it isn't a local session.
 */
function resolveActiveLocalSilent(ctx: CommandContext): LocalSession | null {
  const id = ctx.workspaceManager.getActiveSessionIdForChat(
    ctx.inbound.channelType,
    ctx.inbound.chatId,
  );
  if (!id) return null;
  const s = ctx.sessionManager.get(id);
  if (!s || s.kind !== 'local') return null;
  return s as LocalSession;
}

async function renderPicker(ctx: CommandContext): Promise<void> {
  const ws = workspaceForChat(ctx);
  if (!ws) return;
  const session = resolveActiveLocalSilent(ctx);

  // LocalSession doesn't currently expose a live `permissionMode` getter, but
  // tests inject one on the fake session. Prefer that when present; else fall
  // back to the workspace default.
  const sessionAny = session as unknown as { permissionMode?: PermissionMode } | null;
  const current = sessionAny?.permissionMode ?? ws.defaults.permissionMode;

  const buttons: InlineButton[][] = [
    PICKER_MODES.slice(0, 2).map((m) => ({
      text: `${m}${m === current ? ' ✓' : ''}`,
      callbackData: `runtime:mode:set:${m}`,
    })),
    PICKER_MODES.slice(2).map((m) => ({
      text: `${m}${m === current ? ' ✓' : ''}`,
      callbackData: `runtime:mode:set:${m}`,
    })),
  ];

  const replyMarkup: ReplyMarkup = { type: 'inline_keyboard', buttons };
  await ctx.reply(`🛡 权限模式(当前 session)\n   ${current}`, { replyMarkup });
}
