// src/im/commands/mode.ts
//
// `/mode [<mode>]` — show or switch the current session's permission mode.
// Per spec §3:
//   no-args  → current mode + 4 button picker (default / acceptEdits /
//              bypassPermissions / plan) with ✅ on current
//   <mode>   → setPermissionMode on active session (best effort) + persist
//              as workspace default so new sessions inherit it.
//
// LocalSession does not expose a `permissionMode` getter, so the picker
// reads from the workspace default. When the active session exposes
// `permissionMode` (e.g. test fakes), that wins.
//
// Callback handlers (runtime:mode:set:<m>) are routed via CallbackRouter
// handleRuntimeMode (Task 8.5).

import type { CommandDef, CommandContext } from '../command-parser.js';
import type { PermissionMode } from '../../runtime/types.js';
import type { LocalSession } from '../../session/local-session.js';
import { workspaceForChat } from './_shared.js';
import { renderPicker } from '../picker/picker.js';

/** Picker shows the four canonical modes; aliases (yolo / safe-yolo /
 *  dontAsk) remain valid arg targets but stay off the keyboard. */
const PICKER_ITEMS: Array<{ label: string; value: PermissionMode }> = [
  { label: 'default (按规则)',               value: 'default' },
  { label: 'acceptEdits (自动批准编辑)',      value: 'acceptEdits' },
  { label: 'bypassPermissions (跳过所有权限)', value: 'bypassPermissions' },
  { label: 'plan (只规划)',                  value: 'plan' },
];
const VALID_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'default', 'yolo', 'safe-yolo', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions',
]);

export const modeCmd: CommandDef = {
  name: 'mode',
  description: '查看 / 切换权限模式',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个');
      return;
    }
    if (args.length === 0) {
      await showModePicker(ctx);
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
  const id = ctx.workspaceManager.getActiveSessionId(
    ctx.inbound.channelType,
    ctx.inbound.chatId,
  );
  if (!id) return null;
  const s = ctx.sessionManager.get(id);
  if (!s || s.kind !== 'local') return null;
  return s as LocalSession;
}

async function showModePicker(ctx: CommandContext): Promise<void> {
  const ws = workspaceForChat(ctx);
  if (!ws) return;
  const session = resolveActiveLocalSilent(ctx);

  // LocalSession doesn't currently expose a live `permissionMode` getter, but
  // tests inject one on the fake session. Prefer that when present; else fall
  // back to the workspace default.
  const sessionAny = session as unknown as { permissionMode?: PermissionMode } | null;
  const current: PermissionMode = sessionAny?.permissionMode ?? ws.defaults.permissionMode ?? 'default';

  await renderPicker(ctx, {
    title: `🛡 选择 permission mode\n当前: ${current}`,
    items: PICKER_ITEMS.map((it) => ({
      ...it,
      marker: it.value === current ? '✅' : undefined,
    })),
    callbackPrefix: 'runtime:mode:set',
  });
}
