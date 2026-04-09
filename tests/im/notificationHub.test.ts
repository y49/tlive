import { describe, it, expect, beforeEach } from 'vitest';
import { NotificationHub, type NotificationEvent } from '../../src/im/notificationHub.js';

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'activity_tool',
    dedupeKey: `key-${Math.random()}`,
    sessionId: 'sid',
    title: 'test',
    ...overrides,
  };
}

describe('NotificationHub', () => {
  let hub: NotificationHub;
  beforeEach(() => {
    hub = new NotificationHub({ batchDelay: 50 });
  });

  it('batches aggregatable events and flushes after delay', async () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'a' }));
    hub.push(makeEvent({ dedupeKey: 'b' }));
    expect(batches).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('sends alwaysPush events immediately', () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'c', kind: 'permission_request' }));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('sends ask_user_question events immediately', () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'd', kind: 'ask_user_question' }));
    expect(batches).toHaveLength(1);
  });

  it('deduplicates by key', async () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'dup' }));
    hub.push(makeEvent({ dedupeKey: 'dup' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(batches[0]).toHaveLength(1);
  });

  it('cancels pending batch event', async () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'cancel-me' }));
    expect(hub.cancel('cancel-me')).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(batches).toHaveLength(0);
  });

  it('flushes pending batch before immediate event', () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'batch1' }));
    hub.push(makeEvent({ dedupeKey: 'crit', kind: 'permission_request' }));
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
    expect(batches[1][0].dedupeKey).toBe('crit');
  });

  it('suppresses activity events when user is active', () => {
    const activeHub = new NotificationHub({
      batchDelay: 50,
      isUserActive: () => true,
    });
    const batches: NotificationEvent[][] = [];
    activeHub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    activeHub.push(makeEvent({ dedupeKey: 'act1', kind: 'activity_text' }));
    activeHub.push(makeEvent({ dedupeKey: 'act2', kind: 'activity_tool' }));
    expect(batches).toHaveLength(0);
  });

  it('still pushes alwaysPush events when user is active', () => {
    const activeHub = new NotificationHub({
      batchDelay: 50,
      isUserActive: () => true,
    });
    const batches: NotificationEvent[][] = [];
    activeHub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    activeHub.push(makeEvent({ dedupeKey: 'perm', kind: 'permission_request' }));
    expect(batches).toHaveLength(1);
  });
});
