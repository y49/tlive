// src/workspace/auto-bind.ts
//
// Bootstrap-time helper that turns config-declared channel chatIds into real
// WorkspaceManager bindings. Pure function (no IO beyond logger), so it can
// be unit-tested with a synthetic config.
//
// Single rule: for each channel with a chatId, bind it to the first workspace
// when not already bound. In the multi-workspace case the binding is
// ambiguous — skip and log a warning (users should bind via /workspace in IM).

import type { Logger } from '../util/logger.js';
import type { ChannelType } from './chat-instance.js';
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
  const warnedAmbiguous = new Set<string>();

  for (const w of cfg.workspaces) {
    const target = (w.id ? workspaces.get(w.id) : undefined)
      ?? workspaces.findByWorkdir(w.workdir);
    if (!target) continue;

    for (const [platform, ch] of Object.entries(channels) as Array<[ChannelType, ChannelEntryWithChatId | undefined]>) {
      const chatId = ch?.chatId;
      if (!chatId) continue; // Feishu schema has no chatId; skip.
      if (workspaces.workspaceForChat(platform, chatId)) continue; // already bound somewhere

      // Multi-workspace ambiguity guard: a single channel chatId cannot be
      // automatically assigned to one of N workspaces — skip and warn.
      // Users should bind explicitly via /workspace in IM.
      if (cfg.workspaces.length > 1) {
        const key = `${platform}:${chatId}`;
        if (!warnedAmbiguous.has(key)) {
          warnedAmbiguous.add(key);
          logger.warn('auto-bind skipped: multi-workspace config — bind via /workspace in IM', {
            chatId, platform, candidates: cfg.workspaces.map((x) => x.name),
          });
        }
        continue;
      }

      try {
        workspaces.bindChat({
          workspaceId: target.id,
          channelType: platform,
          chatId,
        });
      } catch {
        // already bound — skip (idempotent when called multiple times)
        continue;
      }
      logger.info('auto-bound chat from config', {
        workspaceId: target.id, workspaceName: target.name, platform, chatId,
      });
      created++;
    }
  }
  return created;
}
