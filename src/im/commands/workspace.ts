// src/im/commands/workspace.ts
//
// /workspace — single entry for workspace management (chat-trust).
// Per spec §4 + §5 — state-adaptive, all inline-keyboard:
//   A: unbound chat, has workspaces → list with [📁 X] buttons
//   B: unbound chat, no workspaces (fresh install) → only [➕ 新增]
//   C: bound → state + switch + manage buttons (any user, no role gate)

import type { CommandDef } from '../command-parser.js';
import type { InlineButton, ReplyMarkup } from '../../platform/types.js';
import type { Workspace } from '../../workspace/config.js';
import type { ChannelType } from '../../workspace/chat-instance.js';
import type { WorkspaceManager } from '../../workspace/manager.js';

export interface WorkspaceCardDeps {
  workspaceManager: WorkspaceManager;
  channelType: ChannelType;
  chatId: string;
}

export interface WorkspaceCard {
  text: string;
  replyMarkup: ReplyMarkup;
}

/**
 * Build the /workspace card for the (channelType, chatId). Pure — no I/O.
 * Shared by the slash-command handler and the `workspace:open` callback so
 * clicking [📁 选工作区] renders the same UI as typing /workspace.
 */
export function buildWorkspaceCard(deps: WorkspaceCardDeps): WorkspaceCard {
  const wm = deps.workspaceManager;
  const ws = wm.workspaceForChat(deps.channelType, deps.chatId);
  const all = wm.list();
  if (!ws) return buildUnbound(all);
  return buildBound(deps, ws, all);
}

function buildUnbound(all: Workspace[]): WorkspaceCard {
  if (all.length === 0) {
    return {
      text: '📁 此 chat 还没进入工作区\n\n(系统暂无任何工作区)',
      replyMarkup: {
        type: 'inline_keyboard',
        buttons: [[{ text: '➕ 新增工作区', callbackData: 'workspace:create:start' }]],
      },
    };
  }
  const buttons: InlineButton[][] = [];
  for (let i = 0; i < all.length; i += 2) {
    const row: InlineButton[] = [];
    for (let j = i; j < Math.min(i + 2, all.length); j++) {
      row.push({ text: `📁 ${all[j]!.name}`, callbackData: `workspace:bind:${all[j]!.id}` });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '➕ 新增工作区', callbackData: 'workspace:create:start' }]);
  return {
    text: '📁 此 chat 还没进入工作区\n\n可用工作区:',
    replyMarkup: { type: 'inline_keyboard', buttons },
  };
}

function buildBound(deps: WorkspaceCardDeps, ws: Workspace, all: Workspace[]): WorkspaceCard {
  const wm = deps.workspaceManager;
  const others = all.filter((w) => w.id !== ws.id);
  const myActiveId = wm.getActiveSessionId(deps.channelType, deps.chatId);
  const allInstances = wm.listChatInstances().filter((c) => c.workspaceId === ws.id);
  const otherInstances = allInstances.filter(
    (c) => !(c.channelType === deps.channelType && c.chatId === deps.chatId),
  );
  const lines = [
    `📁 当前工作区: ${ws.name} ✓`,
    `   📂 ${ws.workdir}`,
    `   🤖 ${ws.defaults.model ?? 'default'} · ${ws.defaults.permissionMode}`,
  ];
  if (myActiveId) lines.push(`   💬 此 chat 的会话: ${myActiveId.slice(0, 8)}`);
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

  return {
    text: lines.join('\n'),
    replyMarkup: { type: 'inline_keyboard', buttons },
  };
}

export const workspaceCmd: CommandDef = {
  name: 'workspace',
  aliases: ['ws'],
  description: '工作区: 看 / 切 / 加 / 退',
  async run(ctx) {
    const card = buildWorkspaceCard({
      workspaceManager: ctx.workspaceManager,
      channelType: ctx.inbound.channelType,
      chatId: ctx.inbound.chatId,
    });
    await ctx.reply(card.text, { replyMarkup: card.replyMarkup });
  },
};
