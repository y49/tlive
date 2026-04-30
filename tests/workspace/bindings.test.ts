// tests/workspace/bindings.test.ts

import { describe, it, expect } from 'vitest';
import { addBinding, removeBinding, findBinding, partitionBindings, type ChatBinding } from '../../src/workspace/bindings.js';

describe('bindings', () => {
  it('addBinding appends to empty array', () => {
    const out = addBinding([], { channelType: 'telegram', chatId: 'c1', role: 'primary' });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('primary');
  });

  it('addBinding promoting new primary demotes existing primary to mirror', () => {
    const initial: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'c1', role: 'primary' },
      { channelType: 'feishu', chatId: 'c2', role: 'mirror' },
    ];
    const out = addBinding(initial, { channelType: 'feishu', chatId: 'c3', role: 'primary' });
    const primaries = out.filter((b) => b.role === 'primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].chatId).toBe('c3');
    const demoted = out.find((b) => b.chatId === 'c1');
    expect(demoted?.role).toBe('mirror');
  });

  it('addBinding dedupes by (channelType, chatId)', () => {
    const initial: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'c1', role: 'primary' },
    ];
    const out = addBinding(initial, { channelType: 'telegram', chatId: 'c1', role: 'mirror' });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('mirror');
  });

  it('addBinding mirror does not demote existing primary', () => {
    const initial: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'c1', role: 'primary' },
    ];
    const out = addBinding(initial, { channelType: 'feishu', chatId: 'c2', role: 'mirror' });
    const primaries = out.filter((b) => b.role === 'primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].chatId).toBe('c1');
  });

  it('removeBinding is idempotent', () => {
    const initial: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'c1', role: 'primary' },
    ];
    const out1 = removeBinding(initial, { channelType: 'telegram', chatId: 'c1' });
    const out2 = removeBinding(out1, { channelType: 'telegram', chatId: 'c1' });
    expect(out1).toEqual([]);
    expect(out2).toEqual([]);
  });

  it('findBinding by (channelType, chatId)', () => {
    const list: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'c1', role: 'primary' },
      { channelType: 'feishu', chatId: 'c1', role: 'mirror' },
    ];
    expect(findBinding(list, { channelType: 'feishu', chatId: 'c1' })?.role).toBe('mirror');
    expect(findBinding(list, { channelType: 'feishu', chatId: 'cZ' })).toBeUndefined();
  });

  it('partitionBindings extracts primary and mirrors', () => {
    const list: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'a', role: 'primary' },
      { channelType: 'feishu', chatId: 'b', role: 'mirror' },
      { channelType: 'feishu', chatId: 'c', role: 'mirror' },
    ];
    const p = partitionBindings(list);
    expect(p.primary?.chatId).toBe('a');
    expect(p.mirrors).toHaveLength(2);
    expect(p.all).toHaveLength(3);
  });

  it('partitionBindings with no primary returns null', () => {
    const list: ChatBinding[] = [
      { channelType: 'telegram', chatId: 'a', role: 'mirror' },
    ];
    const p = partitionBindings(list);
    expect(p.primary).toBeNull();
    expect(p.mirrors).toHaveLength(1);
  });
});
