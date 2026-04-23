// src/platform/discord/slash-commands.ts
//
// Register slash commands at application scope. Discord needs the
// SlashCommandBuilder JSON shape; T7 provides the full command list.

import { REST, Routes, SlashCommandBuilder } from 'discord.js';

export interface SlashCommandSpec {
  name: string;
  description: string;
}

export async function registerSlashCommands(
  token: string,
  applicationId: string,
  specs: SlashCommandSpec[],
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = specs.map((s) => new SlashCommandBuilder().setName(s.name).setDescription(s.description).toJSON());
  await rest.put(Routes.applicationCommands(applicationId), { body });
}
