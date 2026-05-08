// src/im/commands/workspace.ts
//
// /workspace — single entry for workspace management (chat-trust).
// Per spec §4 + §5 — state-adaptive, all inline-keyboard:
//   A: unbound chat, no workspaces (fresh install) → only [➕ 新增]
//   B: unbound chat, system has workspaces → list with [📁 X] buttons
//   C: bound → state + switch + manage buttons (any user, no role gate)

import type { CommandDef, CommandContext } from '../command-parser.js';
import type { InlineButton } from '../../platform/types.js';
import type { Workspace } from '../../workspace/config.js';
import { workspaceForChat } from './_shared.js';

export const workspaceCmd: CommandDef = {
  name: 'workspace',
  aliases: ['ws'],
  description: '工作区: 看 / 切 / 加 / 退',
  async run(ctx) {
    const ws = workspaceForChat(ctx);
    const all = ctx.workspaceManager.list();

    if (!ws) {
      await renderUnbound(ctx, all);
      return;
    }
    await renderBoundAdmin(ctx, ws, all);
  },
};

async function renderUnbound(ctx: CommandContext, all: Workspace[]): Promise<void> {
  if (all.length === 0) {
    await ctx.reply(
      '📁 此 chat 还没进入工作区\n\n(系统暂无任何工作区)',
      {
        replyMarkup: {
          type: 'inline_keyboard',
          buttons: [
            [{ text: '➕ 新增工作区', callbackData: 'workspace:create:start' }],
          ],
        },
      },
    );
    return;
  }

  const buttons: InlineButton[][] = [];
  // 2-column grid of workspace selection buttons
  for (let i = 0; i < all.length; i += 2) {
    const row: InlineButton[] = [];
    for (let j = i; j < Math.min(i + 2, all.length); j++) {
      row.push({
        text: `📁 ${all[j]!.name}`,
        callbackData: `workspace:bind:${all[j]!.id}`,
      });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '➕ 新增工作区', callbackData: 'workspace:create:start' }]);

  await ctx.reply(
    '📁 此 chat 还没进入工作区\n\n可用工作区:',
    { replyMarkup: { type: 'inline_keyboard', buttons } },
  );
}

async function renderBoundAdmin(
  ctx: CommandContext,
  ws: Workspace,
  all: Workspace[],
): Promise<void> {
  const others = all.filter((w) => w.id !== ws.id);
  // Per spec §6.2 — sessions live on ChatInstance, not the Workspace.
  // State C reads the active session for the inbound (channelType, chatId).
  const myActiveId = ctx.workspaceManager.getActiveSessionId(ctx.inbound.channelType, ctx.inbound.chatId);
  const allInstances = ctx.workspaceManager.listChatInstances().filter((c) => c.workspaceId === ws.id);
  const otherInstances = allInstances.filter(
    (c) => !(c.channelType === ctx.inbound.channelType && c.chatId === ctx.inbound.chatId),
  );
  const lines = [
    `📁 当前工作区: ${ws.name} ✓`,
    `   📂 ${ws.workdir}`,
    `   🤖 ${ws.defaults.model ?? 'default'} · ${ws.defaults.permissionMode}`,
  ];
  if (myActiveId) {
    lines.push(`   💬 此 chat 的会话: ${myActiveId.slice(0, 8)}`);
  }
  // Signal isolation: each other chat in this workspace runs its own session.
  if (otherInstances.length > 0) {
    lines.push(`   👥 其他 chat 在此项目: ${otherInstances.length} 个(各自独立)`);
  }

  const buttons: InlineButton[][] = [];
  if (others.length > 0) {
    lines.push('', '切换到:');
    for (let i = 0; i < others.length; i += 2) {
      const row: InlineButton[] = [];
      for (let j = i; j < Math.min(i + 2, others.length); j++) {
        row.push({
          text: `📁 ${others[j]!.name}`,
          callbackData: `workspace:switch:${others[j]!.id}`,
        });
      }
      buttons.push(row);
    }
  }
  buttons.push([
    { text: '➕ 新增工作区', callbackData: 'workspace:create:start' },
    { text: '⚙ 配置', callbackData: 'workspace:config:open' },
    { text: '📤 退出工作区', callbackData: 'workspace:exit:confirm' },
  ]);

  await ctx.reply(lines.join('\n'), {
    replyMarkup: { type: 'inline_keyboard', buttons },
  });
}
