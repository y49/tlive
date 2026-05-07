// src/workspace/bindings.ts
//
// Per-chat binding model (spec docs/superpowers/specs/2026-05-07-isolated-chat-sessions-design.md §3).
// A workspace may bind multiple IM chats; each chat owns its own SDK session
// (`activeSessionId`) so conversations stay independent across chats. The
// previous primary/mirror model is gone — there is no fan-out.
// This file owns the type + array helpers so WorkspaceManager stays focused
// on orchestration.

export type ChannelType = 'telegram' | 'feishu';

export interface ChatBinding {
  channelType: ChannelType;
  chatId: string;
  /** Set when thread-per-session mode is enabled. */
  threadId?: string;
  /**
   * SDK session id currently active for this chat. null when the chat
   * has no live conversation. Persisted across daemon restarts so
   * lazyResumeOrCreate can pick up where the chat left off.
   */
  activeSessionId: string | null;
  /** ISO 8601 timestamp of last inbound or session event. */
  lastActiveAt?: string;
}

/**
 * Add a binding. Duplicate (channelType, chatId) entries are deduplicated
 * by replacing the existing entry. Callers may omit `activeSessionId`; it
 * defaults to null (no live session yet).
 */
export function addBinding(
  bindings: ChatBinding[],
  binding: Omit<ChatBinding, 'activeSessionId'> & { activeSessionId?: string | null },
): ChatBinding[] {
  const dedup = bindings.filter(
    (b) => !(b.channelType === binding.channelType && b.chatId === binding.chatId),
  );
  return [
    ...dedup,
    {
      ...binding,
      activeSessionId: binding.activeSessionId ?? null,
    },
  ];
}

/** Remove a binding by (channelType, chatId). Idempotent. */
export function removeBinding(
  bindings: ChatBinding[],
  key: { channelType: ChannelType; chatId: string },
): ChatBinding[] {
  return bindings.filter((b) => !(b.channelType === key.channelType && b.chatId === key.chatId));
}

export function findBinding(
  bindings: readonly ChatBinding[],
  key: { channelType: ChannelType; chatId: string },
): ChatBinding | undefined {
  return bindings.find((b) => b.channelType === key.channelType && b.chatId === key.chatId);
}
