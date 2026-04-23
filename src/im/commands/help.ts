// src/im/commands/help.ts
//
// `/help` — aggregates tlive-native commands (from the CommandParser
// registry) with the runtime's dynamic `supportedCommands()` list, if any
// active session exists. Observer role is allowed to read help too.

import type { CommandDef } from '../command-parser.js';
import { listCommands } from '../command-parser.js';
import type { LocalSession } from '../../session/local-session.js';

export const helpCmd: CommandDef = {
  name: 'help',
  aliases: ['h', '?'],
  role: ['admin', 'operator', 'observer'],
  description: 'Show available commands',
  async run(ctx) {
    const ws = ctx.workspaceManager.findByChat(ctx.inbound.channelType, ctx.inbound.chatId);
    const activeId = ws?.activeSessionId ?? null;
    const activeSession = activeId ? ctx.sessionManager.get(activeId) : undefined;

    const tliveCmds = listCommands()
      .map((c) => `/${c.name}`)
      .sort();

    let sdkCmds: string[] = [];
    if (activeSession && activeSession.kind === 'local') {
      try {
        const maybe = (activeSession as LocalSession & {
          supportedCommands?: () => Promise<Array<{ name: string }>>;
        }).supportedCommands;
        if (typeof maybe === 'function') {
          const list = await maybe.call(activeSession);
          sdkCmds = list.map((c) => `/${c.name}`);
        }
      } catch {
        // swallow — help is read-only, don't fail
      }
    }

    const parts: string[] = [];
    parts.push('tlive commands:');
    parts.push(tliveCmds.join(', '));
    parts.push('');
    parts.push('Session commands:');
    parts.push(sdkCmds.length > 0 ? sdkCmds.join(', ') : '(no active session)');
    await ctx.reply(parts.join('\n'));
  },
};
