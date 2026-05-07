// src/im/commands/new.ts
//
// /new [prompt] [--ephemeral] [--model=<m>] [--effort=<e>] [--force] —
//   --force: skip the confirm-replace card; stop active session first.
// create a new session in the chat's bound workspace.
// Per spec §3: confirms replacement when an active session exists.

import type { CommandDef } from '../command-parser.js';
import type { ReplyMarkup } from '../../platform/types.js';
import { parseFlags } from '../command-parser.js';
import { workspaceForChat } from './_shared.js';

export const newCmd: CommandDef = {
  name: 'new',
  role: ['admin', 'operator'],
  description: '起新会话',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个');
      return;
    }

    const { flags, positional } = parseFlags(args);
    const force = flags.force === true;

    // Check for an existing active session (unless --force)
    if (ws.activeSessionId && !force) {
      const existing = ctx.sessionManager.get(ws.activeSessionId);
      const aliasText = existing?.shortAlias ?? ws.activeSessionId.slice(0, 8);
      const replyMarkup: ReplyMarkup = {
        type: 'inline_keyboard',
        buttons: [[
          { text: '✅ 替换', callbackData: 'session:new:confirm' },
          { text: '❌ 取消', callbackData: 'session:new:cancel' },
        ]],
      };
      await ctx.reply(
        `⚠ 工作区 "${ws.name}" 已有活跃会话 ${aliasText}。\n确认替换为新会话?`,
        { replyMarkup },
      );
      return;
    }

    let promptRaw = positional.join(' ').trim();
    if (
      (promptRaw.startsWith('"') && promptRaw.endsWith('"')) ||
      (promptRaw.startsWith("'") && promptRaw.endsWith("'"))
    ) {
      if (promptRaw.length >= 2) promptRaw = promptRaw.slice(1, -1);
    }
    const prompt = promptRaw || undefined;
    const model = typeof flags.model === 'string' ? flags.model : ws.defaults.model;
    const effort = typeof flags.effort === 'string'
      ? flags.effort as 'low' | 'medium' | 'high' | 'max'
      : ws.defaults.effort;
    const ephemeral = flags.ephemeral === true;

    // If --force AND there's an existing active session, stop it first
    if (ws.activeSessionId && force) {
      const existing = ctx.sessionManager.get(ws.activeSessionId);
      if (existing && existing.kind === 'local') {
        try { await (existing as never as { stop: () => Promise<void> }).stop(); }
        catch (err) {
          ctx.logger?.warn('new: force-stop existing session failed', {
            sid: ws.activeSessionId,
            reason: (err as Error).message,
          });
        }
      }
      ctx.workspaceManager.clearActiveSession(ws.id);
    }

    const session = await ctx.sessionManager.createLocal({
      workspaceId: ws.id,
      workspaceName: ws.name,
      provider: ws.defaults.provider,
      workdir: ws.workdir,
      initialPrompt: prompt,
      model,
      effort,
      source: 'im',
    });
    try { ctx.workspaceManager.bindActiveSession(ws.id, session.id); }
    catch (err) {
      ctx.logger?.debug('new: bindActiveSession race', {
        reason: (err as Error).message,
      });
    }

    const tag = ephemeral ? ' (ephemeral)' : '';
    await ctx.reply(`✅ 会话 ${session.shortAlias} 已起${tag} · ${ws.name}`);
  },
};
