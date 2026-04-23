// src/platform/telegram/bot-commands.ts
//
// Registers the autocomplete command list via Telegram's setMyCommands API
// (docs: https://core.telegram.org/bots/api#setmycommands). Invoked once on
// adapter start; T7 provides the actual 45 command list.

import type { Bot } from 'grammy';

export interface BotCommandSpec {
  command: string;
  description: string;
}

export async function registerBotCommands(bot: Bot, commands: BotCommandSpec[]): Promise<void> {
  // grammy's api.setMyCommands mirrors Telegram's Bot API verbatim.
  await bot.api.setMyCommands(commands);
}
