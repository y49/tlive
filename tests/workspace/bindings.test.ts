// tests/workspace/bindings.test.ts

import { describe, it, expect } from 'vitest';
import { addBinding, removeBinding, findBinding, type ChatBinding } from '../../src/workspace/chat-instance.js';

describe('bindings', () => {
  it('addBinding appends to empty array', () => {
    const out = addBinding([], { channelType: 'telegram', chatId: 'c1' });
    expect(out).toHaveLength(1);
    expect(out[0]!.chatId).toBe('c1');
  });

  it('addBinding dedupes by (channelType, chatId)', () => {
    const initial: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'c1', activeSessionId: null },
    ];
    const out = addBinding(initial, { channelType: 'telegram', chatId: 'c1', activeSessionId: 'sid-2' });
    expect(out).toHaveLength(1);
    expect(out[0]!.activeSessionId).toBe('sid-2');
  });

  it('removeBinding is idempotent', () => {
    const initial: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'c1', activeSessionId: null },
    ];
    const out1 = removeBinding(initial, { channelType: 'telegram', chatId: 'c1' });
    const out2 = removeBinding(out1, { channelType: 'telegram', chatId: 'c1' });
    expect(out1).toEqual([]);
    expect(out2).toEqual([]);
  });

  it('findBinding by (channelType, chatId)', () => {
    const list: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'c1', activeSessionId: null },
      { channelType: 'feishu', chatId: 'c1', activeSessionId: 'sid-x' },
    ];
    expect(findBinding(list, { channelType: 'feishu', chatId: 'c1' })?.activeSessionId).toBe('sid-x');
    expect(findBinding(list, { channelType: 'feishu', chatId: 'cZ' })).toBeUndefined();
  });
});

describe('addBinding — activeSessionId defaulting (Iso #1)', () => {
  it('addBinding sets activeSessionId=null and no role field', () => {
    const list = addBinding([], { channelType: 'telegram', chatId: 'c1' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      channelType: 'telegram',
      chatId: 'c1',
      activeSessionId: null,
    });
    expect(list[0]).not.toHaveProperty('role');
  });

  it('addBinding preserves activeSessionId when caller supplies it', () => {
    const list = addBinding([], {
      channelType: 'telegram', chatId: 'c1', activeSessionId: 'sid-1',
    });
    expect(list[0]!.activeSessionId).toBe('sid-1');
  });
});
