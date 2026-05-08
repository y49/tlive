// src/im/commands/model.ts
//
// `/model [<id>]` — show or switch the current session's model.
// Per spec §3:
//   no-args  → current model + button list from runtime.supportedModels()
//              + [✏ 自定义] + [设为 workspace 默认] (when current ≠ ws default)
//   <id>     → setModel on active session (best effort) + persist as workspace
//              default so new sessions inherit it.
//
// LocalSession.runtime is `private` in TS but exists at runtime; the picker
// reaches through via a structural cast. Falls through to a picker without
// model rows when the runtime call fails (offline, runtime not ready, etc.).
//
// Callback handlers (runtime:model:set:<id> / :custom / :set-default) are
// wired in Task 31.

import type { CommandDef, CommandContext } from '../command-parser.js';
import type { ReplyMarkup, InlineButton } from '../../platform/types.js';
import type { LocalSession } from '../../session/local-session.js';
import { workspaceForChat } from './_shared.js';

export const modelCmd: CommandDef = {
  name: 'model',
  role: ['admin', 'operator'],
  description: '查看 / 切换模型',
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
    const newModel = args[0]!;
    const session = resolveActiveLocalSilent(ctx);
    if (session) {
      try {
        await session.setModel(newModel);
      } catch (err) {
        await ctx.reply(`❌ 切换失败: ${(err as Error).message}`);
        return;
      }
    }
    ws.defaults.model = newModel;
    await ctx.workspaceManager.save();
    await ctx.reply(`✅ 模型已切到 ${newModel}`);
  },
};

/**
 * Resolve the workspace's active LocalSession without emitting any reply on
 * miss. Returns null when no session is bound, the session is not in the
 * manager, or it isn't a local session. The picker tolerates all of these.
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

interface RuntimeLike {
  supportedModels: () => Promise<Array<{ id: string; displayName?: string; description?: string }>>;
}

async function renderPicker(ctx: CommandContext): Promise<void> {
  const ws = workspaceForChat(ctx);
  if (!ws) return;
  const session = resolveActiveLocalSilent(ctx);

  // Current model: prefer the live session's SDK-reported model, else fall
  // back to the workspace default. Tests inject `sdkModel` directly on a
  // fake session; production reads it from LocalSession's getter.
  const sessionAny = session as unknown as { sdkModel?: string } | null;
  const current = sessionAny?.sdkModel ?? ws.defaults.model ?? '(default)';

  // Pull supported models off the runtime when alive. `runtime` is a private
  // field on LocalSession in TS; the runtime API is stable and present at
  // runtime, so we reach through structurally and swallow failures so the
  // picker still renders [✏ 自定义] when the SDK isn't reachable.
  let supported: Array<{ id: string; displayName?: string; description?: string }> = [];
  try {
    const runtime = (session as unknown as { runtime?: RuntimeLike } | null)?.runtime;
    if (runtime?.supportedModels) supported = await runtime.supportedModels();
  } catch {
    /* ignore — picker still useful with [✏ 自定义] */
  }

  const lines = ['📊 模型(当前 session)', `   ${current}`];

  const buttons: InlineButton[][] = [];
  for (let i = 0; i < supported.length; i += 2) {
    const row: InlineButton[] = [];
    for (let j = i; j < Math.min(i + 2, supported.length); j++) {
      const m = supported[j]!;
      const label = m.displayName ?? m.id;
      const checked = m.id === current ? ' ✓' : '';
      row.push({ text: `${label}${checked}`, callbackData: `runtime:model:set:${m.id}` });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '✏ 自定义', callbackData: 'runtime:model:custom' }]);
  if (current !== ws.defaults.model && current !== '(default)') {
    buttons.push([{ text: '设为 workspace 默认', callbackData: 'runtime:model:set-default' }]);
  }

  const replyMarkup: ReplyMarkup = { type: 'inline_keyboard', buttons };
  await ctx.reply(lines.join('\n'), { replyMarkup });
}
