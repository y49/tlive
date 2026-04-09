// bridge/src/engine/target-resolver.ts
//
// Target resolution — determine where to send notifications per platform.
// Extracted from terminal-relay.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  chatId: string;
  receiveIdType?: string;
}

export type GetLastChatId = (channelType: string) => string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect feishu receive_id_type from ID prefix convention. */
function feishuReceiveIdType(id: string): string {
  if (id.startsWith('ou_')) return 'open_id';
  if (id.startsWith('oc_')) return 'chat_id';
  return 'user_id';
}

// ---------------------------------------------------------------------------
// TargetResolver
// ---------------------------------------------------------------------------

export class TargetResolver {
  private cachedChatIds: Record<string, string> = {};
  private platformResolvers: Record<string, () => ResolvedTarget | null>;

  constructor(
    private getLastChatId: GetLastChatId,
    config: Config,
    tliveHome: string,
  ) {
    // Load persisted chat IDs
    const chatIdsFile = join(tliveHome, 'runtime', 'chat-ids.json');
    try { this.cachedChatIds = JSON.parse(readFileSync(chatIdsFile, 'utf-8')); } catch { /* none */ }

    // Per-platform config-based fallback
    this.platformResolvers = {
      telegram: () => config.telegram.chatId ? { chatId: config.telegram.chatId } : null,
      feishu: () => {
        const id = config.feishu.allowedUsers[0];
        return id ? { chatId: id, receiveIdType: feishuReceiveIdType(id) } : null;
      },
      discord: () => null,
    };
  }

  resolve(channelType: string): ResolvedTarget | null {
    // 1. Active session (recent IM interaction)
    const active = this.getLastChatId(channelType);
    if (active) return this.withIdType(channelType, active);

    // 2. Platform config
    const fromConfig = this.platformResolvers[channelType]?.();
    if (fromConfig) return fromConfig;

    // 3. Persisted cache
    const cached = this.cachedChatIds[channelType];
    if (cached) return this.withIdType(channelType, cached);

    return null;
  }

  private withIdType(channelType: string, chatId: string): ResolvedTarget {
    return {
      chatId,
      receiveIdType: channelType === 'feishu' ? feishuReceiveIdType(chatId) : undefined,
    };
  }
}
