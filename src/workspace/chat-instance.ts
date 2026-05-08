// Per-chat runtime instance (spec 2026-05-08 §3.2). Each (channelType, chatId)
// has at most one ChatInstance binding it to a Workspace template. ChatInstance
// owns runtime state: activeSessionId, costRollup, optional per-chat settings
// override. Workspace itself is now a pure template (no binding nesting).
//
// chat-trust: no admins field. Anyone in the chat can drive the bot.

import type { PermissionMode, ThinkingLevel } from '../runtime/types.js';

export type ChannelType = 'telegram' | 'feishu';

export interface ChatInstanceSettings {
  model?: string;
  permissionMode?: PermissionMode;
  thinking?: ThinkingLevel;
}

export interface ChatInstanceCostRollup {
  totalUsd: number;
  sessionCount: number;
  /** ISO 8601 — initialized to createdAt at bind time. */
  lastResetAt: string;
}

export interface ChatInstance {
  channelType: ChannelType;
  chatId: string;
  /** Optional thread/topic id for platforms that use them (Telegram topics). */
  threadId?: string;
  workspaceId: string;
  /** Currently-active SDK session id, null when no live conversation. */
  activeSessionId: string | null;
  /** ISO 8601 of last inbound or session event. null when never used. */
  lastActiveAt: string | null;
  /** Per-chat settings override; v1 schema-only, no UI. */
  settings?: ChatInstanceSettings;
  costRollup: ChatInstanceCostRollup;
  createdAt: string;
}

export function addChatInstance(list: readonly ChatInstance[], next: ChatInstance): ChatInstance[] {
  if (!next.chatId) {
    throw new Error(`addChatInstance: chatId is required (got empty for ${next.channelType})`);
  }
  const dedup = list.filter(
    (c) => !(c.channelType === next.channelType && c.chatId === next.chatId),
  );
  return [...dedup, next];
}

export function removeChatInstance(
  list: readonly ChatInstance[],
  key: { channelType: ChannelType; chatId: string },
): ChatInstance[] {
  return list.filter((c) => !(c.channelType === key.channelType && c.chatId === key.chatId));
}

export function findChatInstance(
  list: readonly ChatInstance[],
  key: { channelType: ChannelType; chatId: string },
): ChatInstance | undefined {
  return list.find((c) => c.channelType === key.channelType && c.chatId === key.chatId);
}

export function newCostRollup(at: string): ChatInstanceCostRollup {
  return { totalUsd: 0, sessionCount: 0, lastResetAt: at };
}
