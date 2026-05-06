// src/im/commands/workspace.ts
//
// /workspace — single entry for workspace management (v3.3).
// Per spec §4 — state-adaptive, all inline-keyboard:
//   A: unbound chat, system has workspaces → list with [📁 X] buttons
//   B: unbound chat, no workspaces (fresh install) → only [➕ 新增]
//   C: bound + admin → state + switch + manage buttons
//   D: bound + non-admin → read-only

import type { CommandDef, CommandContext } from '../command-parser.js';
import type { InlineButton } from '../../platform/types.js';
import type { Workspace } from '../../workspace/config.js';
import { workspaceForChat } from './_shared.js';

export const workspaceCmd: CommandDef = {
  name: 'workspace',
  aliases: ['ws'],
  role: ['admin', 'operator', 'observer'],
  description: '工作区: 看 / 切 / 加 / 退',
  async run(ctx) {
    const ws = workspaceForChat(ctx);
    const all = ctx.workspaceManager.list();

    if (!ws) {
      await renderUnbound(ctx, all);
      return;
    }
    const role = ctx.workspaceManager.getRole(ws.id, ctx.userId);
    if (role !== 'admin') {
      await renderReadOnly(ctx, ws);
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

async function renderBoundAdmin(ctx: CommandContext, ws: Workspace, all: Workspace[]): Promise<void> {
  const others = all.filter((w) => w.id !== ws.id);
  const lines = [
    `📁 当前工作区: ${ws.name} ✓`,
    `   📂 ${ws.workdir}`,
    `   🤖 ${ws.defaults.model ?? 'default'} · ${ws.defaults.permissionMode}`,
  ];
  if (ws.activeSessionId) {
    lines.push(`   🔗 active session: ${ws.activeSessionId.slice(0, 8)}`);
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

async function renderReadOnly(ctx: CommandContext, ws: Workspace): Promise<void> {
  await ctx.reply(
    `📁 工作区: ${ws.name} (只读)\n   📂 ${ws.workdir}\n   你不是该工作区的管理员,无法切换或配置`,
  );
}
