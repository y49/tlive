import { describe, it, expect } from 'vitest';
import { EventHub, type EventClient, type EventFrame } from '../event-hub';

class FakeClient implements EventClient {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  throwOnSend = false;
  send(d: string): void { if (this.throwOnSend) throw new Error('broken'); this.sent.push(d); }
  close(): void { this.closed = true; }
}

const frame: EventFrame = { type: 'session-remove', id: '/r' };

describe('EventHub', () => {
  it('broadcasts a JSON frame to every open client', () => {
    const hub = new EventHub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a); hub.add(b);
    hub.broadcast(frame);
    expect(a.sent).toEqual([JSON.stringify(frame)]);
    expect(b.sent).toEqual([JSON.stringify(frame)]);
  });

  it('skips and prunes clients that are not OPEN', () => {
    const hub = new EventHub();
    const dead = new FakeClient();
    dead.readyState = 3;
    hub.add(dead);
    hub.broadcast(frame);
    expect(dead.sent).toEqual([]);
    expect(hub.size()).toBe(0);
  });

  it('prunes and closes a client whose send throws', () => {
    const hub = new EventHub();
    const bad = new FakeClient();
    bad.throwOnSend = true;
    hub.add(bad);
    hub.broadcast(frame);
    expect(bad.closed).toBe(true);
    expect(hub.size()).toBe(0);
  });

  it('remove drops a client', () => {
    const hub = new EventHub();
    const a = new FakeClient();
    hub.add(a); hub.remove(a);
    hub.broadcast(frame);
    expect(a.sent).toEqual([]);
  });
});
