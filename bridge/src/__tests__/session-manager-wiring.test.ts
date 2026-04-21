import { describe, it, expect, vi } from 'vitest';

// We do not instantiate a full BridgeManager in the test — it has heavy deps
// (config, persistent stores, channel adapters). Instead, exercise the
// SessionFrontend stub directly, verifying it subscribes to the manager
// on start() and forwards the 'created' event to attachToSession.

import { SessionFrontend } from '../engine/session-frontend.js';

describe('SessionFrontend wiring', () => {
  it('subscribes to SessionManager on start and attaches on created event', () => {
    const subscribers: Array<(ev: unknown) => void> = [];
    const sessionSubscribers = new Map<string, Array<(ev: unknown) => void>>();
    const mgrStub = {
      subscribe: vi.fn((cb: (ev: unknown) => void) => { subscribers.push(cb); return () => {}; }),
      subscribeToSession: vi.fn((id: string, cb: (ev: unknown) => void) => {
        const arr = sessionSubscribers.get(id) ?? [];
        arr.push(cb);
        sessionSubscribers.set(id, arr);
        return () => {};
      }),
    };
    const frontend = new SessionFrontend(
      mgrStub as any,
      {} as any,  // ChannelRouter not needed for this test
      new Map() as any,
    );
    frontend.start();
    expect(mgrStub.subscribe).toHaveBeenCalledTimes(1);

    // Fire a 'created' event
    subscribers[0]!({ kind: 'created', session: { id: 's1' } });
    expect(mgrStub.subscribeToSession).toHaveBeenCalledWith('s1', expect.any(Function));
  });

  it('ignores non-created/resumed manager events', () => {
    const subscribers: Array<(ev: unknown) => void> = [];
    const mgrStub = {
      subscribe: vi.fn((cb: (ev: unknown) => void) => { subscribers.push(cb); return () => {}; }),
      subscribeToSession: vi.fn(() => () => {}),
    };
    const frontend = new SessionFrontend(mgrStub as any, {} as any, new Map() as any);
    frontend.start();
    subscribers[0]!({ kind: 'stopped', sessionId: 's1' });
    expect(mgrStub.subscribeToSession).not.toHaveBeenCalled();
  });
});
