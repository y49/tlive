// src/im/render-target.ts
//
// RenderTarget — destination (workspace binding) for IM output. Extracted
// from the legacy src/im/render/types.ts so HUD code can depend on it
// without dragging in renderer-specific types that will be deleted in T10.

import type { ChannelType } from '../workspace/bindings.js';

export interface RenderTarget {
  channelType: ChannelType;
  chatId: string;
  threadId?: string;
  /** primary receives buttons; mirrors get read-only echoes. */
  role: 'primary' | 'mirror';
}

/** Stable map key for a (channelType, chatId, threadId?) tuple. */
export function targetKey(t: RenderTarget): string {
  return t.threadId ? `${t.channelType}:${t.chatId}:${t.threadId}` : `${t.channelType}:${t.chatId}`;
}
