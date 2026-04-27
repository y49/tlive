// src/workspace/auto-bind.ts
//
// Bootstrap-time helper that turns config-declared chat ids and adminUserId
// into real WorkspaceManager bindings. Pure function (no IO beyond logger),
// so it can be unit-tested with a synthetic config.
//
// Single rule: for each (workspace × channel-with-chatId) pair, add a
// `primary` binding when the chat is not already bound anywhere AND the
// pairing is unambiguous in the multi-workspace case.

import type { Logger } from '../util/logger.js';
import type { ChannelType } from './bindings.js';
import type { WorkspaceManager } from './manager.js';
import type { TliveConfigV1 } from '../config/schema.js';

interface ChannelEntryWithChatId { chatId?: string }

export function autoBindFromConfig(
  workspaces: WorkspaceManager,
  cfg: TliveConfigV1,
  logger: Logger,
): number {
  let created = 0;
  const channels = cfg.channels ?? {};

  for (const w of cfg.workspaces) {
    const target = (w.id ? workspaces.get(w.id) : undefined)
      ?? workspaces.findByWorkdir(w.workdir);
    if (!target) continue;

    for (const [platform, ch] of Object.entries(channels) as Array<[ChannelType, ChannelEntryWithChatId | undefined]>) {
      const chatId = ch?.chatId;
      if (!chatId) continue; // Feishu/Discord schema has no chatId; skip.
      if (workspaces.findByChat(platform, chatId)) continue; // already bound somewhere

      // Multi-workspace ambiguity guard: if any other workspace also wants
      // this chatId via adminUserId, only the matching one wins.
      if (cfg.workspaces.length > 1) {
        const matchesAnyAdmin = cfg.workspaces.some((o) => o.adminUserId === chatId);
        const matchesThisAdmin = w.adminUserId === chatId;
        if (matchesAnyAdmin && !matchesThisAdmin) continue;
        if (!matchesAnyAdmin) {
          logger.warn('auto-bind skipped: multi-workspace and no adminUserId matches chatId', {
            chatId, platform, candidates: cfg.workspaces.map((x) => x.name),
          });
          continue;
        }
      }

      workspaces.addBinding(target.id, {
        channelType: platform,
        chatId,
        role: 'primary',
      });
      logger.info('auto-bound chat from config', {
        workspaceId: target.id, workspaceName: target.name, platform, chatId,
      });
      created++;
    }
  }
  return created;
}
