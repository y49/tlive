// src/im/bot-commands-registrar.ts
//
// Registers the top-16 slash commands on every platform that supports
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
 * The 16 commands registered for autocomplete. Chosen for discoverability
 * and IM-mobile ergonomics: heavy use + short enough to type on a phone.
 */
export const TOP_COMMANDS: BotCommandSpec[] = [
  { command: 'help',     description: 'Show command help' },
  { command: 'bind',     description: 'Bind this chat to a workspace (admin)' },
  { command: 'new',      description: 'Create a new session' },
  { command: 'stop',     description: 'Interrupt the current turn' },
  { command: 'kill',     description: 'Force kill session + release jsonl' },
  { command: 'sessions', description: 'List sessions (paginated)' },
  { command: 'resume',   description: 'Resume a stopped session by short-id' },
  { command: 'status',   description: 'Show current session status' },
  { command: 'model',    description: 'Show or change model' },
  { command: 'mode',     description: 'Show or change permission mode' },
  { command: 'search',   description: 'Search messages across sessions' },
  { command: 'export',   description: 'Export a session to md/json/jsonl' },
  { command: 'cost',     description: 'Show cost dashboard' },
  { command: 'budget',   description: 'Set session budget (USD)' },
  { command: 'fork',     description: 'Fork a session with a new title' },
  { command: 'rename',   description: 'Rename a session' },
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
