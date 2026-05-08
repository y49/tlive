// src/im/commands/help.ts
//
// /help — grouped command catalog. Static groupings since v3.3
// surface is fixed at 12 commands.

import type { CommandDef } from '../command-parser.js';
import type { LocalSession } from '../../session/local-session.js';

export const helpCmd: CommandDef = {
  name: 'help',
  aliases: ['h', '?'],
  role: ['admin', 'operator', 'observer'],
  description: '查看帮助和命令列表',
  async run(ctx) {
    const lines = [
      '📖 tlive 命令 (v3.3)',
      '',
      '🗂  会话(各 chat 独立)',
      '   /new           起新会话',
      '   /sessions      当前 chat 的会话(--all 跨 chat)',
      '   /workspace     工作区: 看 / 切 / 加 / 退',
      '   /cost          累计成本',
      '   /find <kw>     搜历史',
      '',
      '🎛  当前对话 (session-scoped)',
      '   /stop          中断当前生成 (Ctrl+C)',
      '   /model         查看 / 切模型',
      '   /mode          权限模式',
      '   /think         思考深度',
      '   /perm          权限规则',
      '   /budget        预算上限',
      '',
      '📖 帮助',
      '   /help          查看本帮助',
      '',
      '💡 大部分操作不用打字 — 看每条回复下面的按钮',
    ];

    // Optionally append SDK supportedCommands if a session is alive
    const activeId = ctx.workspaceManager.getActiveSessionId(
      ctx.inbound.channelType,
      ctx.inbound.chatId,
    );
    const activeSession = activeId ? ctx.sessionManager.get(activeId) : undefined;
    if (activeSession && activeSession.kind === 'local') {
      try {
        const maybe = (activeSession as LocalSession & {
          supportedCommands?: () => Promise<Array<{ name: string }>>;
        }).supportedCommands;
        if (typeof maybe === 'function') {
          const list = await maybe.call(activeSession);
          if (list.length > 0) {
            lines.push('', 'SDK 内置命令:', '   ' + list.map((c) => `/${c.name}`).join(' '));
          }
        }
      } catch (err) {
        ctx.logger?.warn('help: SDK supportedCommands failed', {
          reason: (err as Error).message,
        });
      }
    }

    await ctx.reply(lines.join('\n'));
  },
};
