// src/platform/discord/thread.ts
//
// Discord thread-per-session helper. When `workspace.threadPerSession` is
// enabled, the daemon asks DiscordAdapter to start a thread off a parent
// message and binds subsequent renders into that thread id.

import { ChannelType, type TextChannel } from 'discord.js';

export interface StartSessionThreadInput {
  channel: TextChannel;
  parentMessageId?: string;
  name: string;
  /** Minutes after which the thread archives on inactivity. */
  autoArchiveMinutes?: 60 | 1440 | 4320 | 10080;
}

export async function startSessionThread(input: StartSessionThreadInput): Promise<string> {
  const thread = await input.channel.threads.create({
    name: input.name.slice(0, 95),
    startMessage: input.parentMessageId,
    autoArchiveDuration: input.autoArchiveMinutes ?? 1440,
    type: ChannelType.PublicThread,
  });
  return thread.id;
}
