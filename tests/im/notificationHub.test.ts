import { describe, it, expect, beforeEach } from 'vitest';
import { NotificationHub, type NotificationEvent } from '../../src/im/notificationHub.js';

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'activity',
    dedupeKey: `key-${Math.random()}`,
    severity: 'info',
    requiresUserAction: false,
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

  it('batches info events and flushes after delay', async () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'a' }));
    hub.push(makeEvent({ dedupeKey: 'b' }));
    expect(batches).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('sends critical events immediately', () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'c', severity: 'critical' }));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('sends requiresUserAction events immediately', () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'd', requiresUserAction: true }));
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

  it('flushes pending batch before critical event', () => {
    const batches: NotificationEvent[][] = [];
    hub.on('notify', (b: NotificationEvent[]) => batches.push(b));
    hub.push(makeEvent({ dedupeKey: 'info1' }));
    hub.push(makeEvent({ dedupeKey: 'crit', severity: 'critical' }));
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
    expect(batches[1][0].dedupeKey).toBe('crit');
  });
});
