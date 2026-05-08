// src/im/commands/model.ts
//
// `/model [<id>]` — show or switch the current session's model.
// Per spec §3:
//   no-args  → current model + button list from runtime.supportedModels()
//              (F2 picker via KNOWN_MODELS fallback when runtime unavailable)
//              + [✏ 自定义] + [设为 workspace 默认] (when current ≠ ws default)
//   <id>     → setModel on active session (best effort) + persist as workspace
//              default so new sessions inherit it.
//
// LocalSession.runtime is `private` in TS but exists at runtime; the picker
// reaches through via a structural cast. Falls through to F2 KNOWN_MODELS
// picker when the runtime call fails (offline, runtime not ready, etc.).
//
// Callback handlers (runtime:model:set:<id> / :custom / :set-default) are
// handled by CallbackRouter.handleRuntimeModel (Task 8.5 added role check).

import type { CommandDef, CommandContext } from '../command-parser.js';
import type { ReplyMarkup, InlineButton } from '../../platform/types.js';
import type { LocalSession } from '../../session/local-session.js';
import { workspaceForChat } from './_shared.js';

// Known models for fallback when runtime.supportedModels() is unavailable.
// Displayed via F2 InteractivePicker with runtime:model:set:* callback prefix
// (handled by CallbackRouter.handleRuntimeModel — Approach 1, additive).
const KNOWN_MODELS = [
  { label: 'Claude Opus 4.7 (latest)', value: 'claude-opus-4-7' },
  { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { label: 'Claude Opus 4.5', value: 'claude-opus-4-5' },
  { label: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5' },
];

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
  const current = sessionAny?.sdkModel ?? ws.defaults.model ?? KNOWN_MODELS[0]!.value;

  // Pull supported models off the runtime when alive. `runtime` is a private
  // field on LocalSession in TS; the runtime API is stable and present at
  // runtime, so we reach through structurally and swallow failures so the
  // F2 KNOWN_MODELS picker is used when the SDK isn't reachable.
  let supported: Array<{ id: string; displayName?: string; description?: string }> = [];
  try {
    const runtime = (session as unknown as { runtime?: RuntimeLike } | null)?.runtime;
    if (runtime?.supportedModels) supported = await runtime.supportedModels();
  } catch {
    /* ignore — fall through to F2 KNOWN_MODELS picker */
  }

  // Build model row buttons from live runtime results, or fall back to
  // KNOWN_MODELS via F2 InteractivePicker items when the runtime is offline.
  // Callbacks always use runtime:model:set:<id> so CallbackRouter.handleRuntimeModel
  // handles them regardless of source (Approach 1 — additive, no migration).
  const modelSource: Array<{ id: string; label: string }> =
    supported.length > 0
      ? supported.map((m) => ({ id: m.id, label: m.displayName ?? m.id }))
      : KNOWN_MODELS.map((m) => ({ id: m.value, label: m.label }));

  const lines =
    supported.length > 0
      ? ['📊 模型(当前 session)', `   ${current}`]
      : [`选择模型 (当前: ${current})`];

  const buttons: InlineButton[][] = [];
  for (let i = 0; i < modelSource.length; i += 2) {
    const row: InlineButton[] = [];
    for (let j = i; j < Math.min(i + 2, modelSource.length); j++) {
      const m = modelSource[j]!;
      const checked = m.id === current
        ? (supported.length > 0 ? ' ✓' : ' ✅')
        : '';
      row.push({ text: `${m.label}${checked}`, callbackData: `runtime:model:set:${m.id}` });
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
