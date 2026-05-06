import { describe, it, expect } from 'vitest';
import { WorkspaceCreateBroker } from '../../src/im/workspace-create-broker.js';

describe('WorkspaceCreateBroker', () => {
  it('start + pendingFor returns the entry', () => {
    const b = new WorkspaceCreateBroker();
    b.start({ channelType: 'telegram', chatId: 'c1', userId: 'u1', triggerMessageId: 'm1' });
    const p = b.pendingFor('telegram', 'c1');
    expect(p?.userId).toBe('u1');
    expect(p?.triggerMessageId).toBe('m1');
    expect(p?.startedAtMs).toBeGreaterThan(0);
  });

  it('resolve removes the entry', () => {
    const b = new WorkspaceCreateBroker();
    b.start({ channelType: 'telegram', chatId: 'c1', userId: 'u1', triggerMessageId: 'm1' });
    b.resolve('telegram', 'c1');
    expect(b.pendingFor('telegram', 'c1')).toBeUndefined();
  });

  it('cancel removes the entry', () => {
    const b = new WorkspaceCreateBroker();
    b.start({ channelType: 'telegram', chatId: 'c1', userId: 'u1', triggerMessageId: 'm1' });
    b.cancel('telegram', 'c1');
    expect(b.pendingFor('telegram', 'c1')).toBeUndefined();
  });

  it('starting twice on same chat replaces', () => {
    const b = new WorkspaceCreateBroker();
    b.start({ channelType: 'telegram', chatId: 'c1', userId: 'u1', triggerMessageId: 'm1' });
    b.start({ channelType: 'telegram', chatId: 'c1', userId: 'u2', triggerMessageId: 'm2' });
    expect(b.pendingFor('telegram', 'c1')?.userId).toBe('u2');
    expect(b.size()).toBe(1);
  });

  it('different channels do not collide', () => {
    const b = new WorkspaceCreateBroker();
    b.start({ channelType: 'telegram', chatId: 'c1', userId: 'u1', triggerMessageId: 'm1' });
    b.start({ channelType: 'feishu', chatId: 'c1', userId: 'u2', triggerMessageId: 'm2' });
    expect(b.pendingFor('telegram', 'c1')?.userId).toBe('u1');
    expect(b.pendingFor('feishu', 'c1')?.userId).toBe('u2');
  });

  it('pruneExpired removes entries older than maxAge', () => {
    const b = new WorkspaceCreateBroker();
    const now = Date.now();
    b.start({
      channelType: 'telegram', chatId: 'c1', userId: 'u1',
      triggerMessageId: 'm1', startedAtMs: now - 10 * 60 * 1000, // 10 min old
    });
    b.start({
      channelType: 'telegram', chatId: 'c2', userId: 'u2',
      triggerMessageId: 'm2', startedAtMs: now,
    });
    const removed = b.pruneExpired(5 * 60 * 1000);
    expect(removed).toBe(1);
    expect(b.pendingFor('telegram', 'c1')).toBeUndefined();
    expect(b.pendingFor('telegram', 'c2')).toBeDefined();
  });
});
