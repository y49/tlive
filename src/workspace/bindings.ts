// src/workspace/bindings.ts
//
// Multi-chat binding model (spec §6.2). A workspace may fan out to multiple
// IM chats; exactly one is `primary` (receives interactive buttons /
// elicitation forms) and the rest are `mirror` (read-only renders,
// permission cards show "Respond from <primary>"). This file owns the
// type + array helpers so WorkspaceManager stays focused on orchestration.

export type ChannelType = 'telegram' | 'discord' | 'feishu';

export interface ChatBinding {
  channelType: ChannelType;
  chatId: string;
  role: 'primary' | 'mirror';
  /** Set when thread-per-session mode is enabled. */
  threadId?: string;
}

export interface BindingsResult {
  primary: ChatBinding | null;
  mirrors: ChatBinding[];
  all: ChatBinding[];
}

/** Sort bindings into `primary` (at most one) and `mirror` arrays. */
export function partitionBindings(bindings: readonly ChatBinding[]): BindingsResult {
  let primary: ChatBinding | null = null;
  const mirrors: ChatBinding[] = [];
  for (const b of bindings) {
    if (b.role === 'primary' && !primary) primary = b;
    else mirrors.push({ ...b, role: 'mirror' });
  }
  return { primary, mirrors, all: [...bindings] };
}

/**
 * Add a binding. Policy:
 * - Pushing a `primary` while another primary exists demotes the old one to mirror.
 * - Duplicate (channelType, chatId) entries are deduplicated by replacing in place.
 */
export function addBinding(
  bindings: ChatBinding[],
  next: ChatBinding,
): ChatBinding[] {
  const deduped = bindings.filter((b) => !(b.channelType === next.channelType && b.chatId === next.chatId));
  const result = next.role === 'primary'
    ? deduped.map((b) => (b.role === 'primary' ? { ...b, role: 'mirror' as const } : b))
    : deduped;
  result.push(next);
  return result;
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
