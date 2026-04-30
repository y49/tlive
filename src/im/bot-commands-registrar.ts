// src/im/bot-commands-registrar.ts
//
// Registers the 12 v3.3 slash commands on every platform that supports
// autocomplete. Called once on daemon start by T9 bootstrap.
//
// Platforms:
// - Telegram: setMyCommands via the grammy Bot instance.
// - Feishu: no-op (no first-party autocomplete surface).

import type { PlatformAdapter } from '../platform/types.js';
import type { ChannelType } from '../workspace/bindings.js';
import type { BotCommandSpec } from '../platform/telegram/bot-commands.js';
import { registerBotCommands as telegramRegister } from '../platform/telegram/bot-commands.js';

/**
 * The 12 commands registered for autocomplete — the entire v3.3 surface.
 * Per spec §3.4: command name English, description Chinese for mobile readability.
 */
export const TOP_COMMANDS: BotCommandSpec[] = [
  { command: 'help',      description: '查看帮助和命令列表' },
  { command: 'new',       description: '起新会话' },
  { command: 'sessions',  description: '当前工作区的会话列表' },
  { command: 'workspace', description: '工作区: 看 / 切 / 加 / 退' },
  { command: 'stop',      description: '中断当前生成 (Ctrl+C)' },
  { command: 'model',     description: '查看 / 切换模型' },
  { command: 'mode',      description: '查看 / 切换权限模式' },
  { command: 'think',     description: '思考深度' },
  { command: 'perm',      description: 'Session 权限规则' },
  { command: 'cost',      description: '工作区累计成本' },
  { command: 'budget',    description: '当前 session 预算上限' },
  { command: 'find',      description: '搜索工作区会话历史' },
];

interface TelegramAdapterShape extends PlatformAdapter {
  // grammy Bot is exposed via a private field in our TelegramAdapter; we
  // duck-type on `.registerBotCommands` first if the caller added one.
  registerBotCommands?: (commands: BotCommandSpec[]) => Promise<void>;
  /** fallback: expose the underlying grammy Bot */
  bot?: unknown;
}

/**
 * Register the TOP_COMMANDS list on every adapter that supports it.
 * Swallows per-adapter errors so a single misconfigured platform doesn't
 * block daemon startup.
 */
export async function registerAllBotCommands(
  adapters: Partial<Record<ChannelType, PlatformAdapter>>,
): Promise<Record<ChannelType, 'registered' | 'skipped' | 'failed'>> {
  const outcome: Record<ChannelType, 'registered' | 'skipped' | 'failed'> = {
    telegram: 'skipped',
    feishu: 'skipped',
  };

  // Telegram: direct grammy API.
  const tg = adapters.telegram as TelegramAdapterShape | undefined;
  if (tg) {
    try {
      if (tg.registerBotCommands) {
        await tg.registerBotCommands(TOP_COMMANDS);
      } else if (tg.bot) {
        await telegramRegister(tg.bot as Parameters<typeof telegramRegister>[0], TOP_COMMANDS);
      } else {
        outcome.telegram = 'skipped';
      }
      if (tg.registerBotCommands || tg.bot) outcome.telegram = 'registered';
    } catch {
      outcome.telegram = 'failed';
    }
  }

  // Feishu: no-op.
  outcome.feishu = 'skipped';

  return outcome;
}
