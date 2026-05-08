// tests/workspace/chat-instance.test.ts
import { describe, it, expect } from 'vitest';
import {
  type ChatInstance,
  type ChannelType,
  addChatInstance,
  removeChatInstance,
  findChatInstance,
} from '../../src/workspace/chat-instance.js';

describe('ChatInstance helpers', () => {
  it('findChatInstance returns matching record by (channelType, chatId)', () => {
    const list: ChatInstance[] = [
      mkInstance('telegram', 'tg-1', 'ws-A'),
      mkInstance('feishu', 'fs-x', 'ws-B'),
    ];
    expect(findChatInstance(list, { channelType: 'telegram', chatId: 'tg-1' }))
      .toMatchObject({ workspaceId: 'ws-A' });
    expect(findChatInstance(list, { channelType: 'telegram', chatId: 'missing' }))
      .toBeUndefined();
  });

  it('addChatInstance dedupes by (channelType, chatId), keeping the new entry', () => {
    const list: ChatInstance[] = [mkInstance('telegram', 'tg-1', 'ws-A')];
    const next = addChatInstance(list, mkInstance('telegram', 'tg-1', 'ws-B'));
    expect(next).toHaveLength(1);
    expect(next[0]!.workspaceId).toBe('ws-B');
  });

  it('removeChatInstance is idempotent', () => {
    const list: ChatInstance[] = [mkInstance('telegram', 'tg-1', 'ws-A')];
    expect(removeChatInstance(list, { channelType: 'telegram', chatId: 'tg-1' }))
      .toHaveLength(0);
    expect(removeChatInstance([], { channelType: 'telegram', chatId: 'tg-1' }))
      .toEqual([]);
  });

  it('rejects empty chatId in addChatInstance', () => {
    expect(() => addChatInstance([], mkInstance('telegram', '', 'ws-A')))
      .toThrow(/chatId is required/);
  });
});

function mkInstance(channelType: ChannelType, chatId: string, workspaceId: string): ChatInstance {
  return {
    channelType,
    chatId,
    workspaceId,
    activeSessionId: null,
    lastActiveAt: null,
    costRollup: { totalUsd: 0, sessionCount: 0, lastResetAt: '2026-05-08T00:00:00.000Z' },
    createdAt: '2026-05-08T00:00:00.000Z',
  };
}
