import { describe, it, expect, vi } from 'vitest';
import { SessionFrontend } from '../engine/session-frontend.js';

function stubs() {
  const managerSubs: Array<(ev: unknown) => void> = [];
  const brokerSubs: Array<(ev: unknown) => void> = [];
  const sessionSubs = new Map<string, Array<(ev: unknown) => void>>();

  const makeSession = (id: string) => ({
    id,
    context: {
      workspaceId: 'ws', workspaceName: 'ws', workdir: '/a',
      sessionId: id, provider: 'claude', createdAt: 1,
    },
    subscribe: (cb: (ev: unknown) => void) => {
      const arr = sessionSubs.get(id) ?? [];
      arr.push(cb);
      sessionSubs.set(id, arr);
      return () => {
        sessionSubs.set(
          id,
          (sessionSubs.get(id) ?? []).filter((x) => x !== cb),
        );
      };
    },
  });

  return {
    mgr: {
      subscribe: (cb: (ev: unknown) => void) => { managerSubs.push(cb); return () => { /* noop */ }; },
      get: (id: string) => (sessionSubs.has(id) ? makeSession(id) : null),
      fireCreated: (id: string) => managerSubs.forEach((s) => s({ kind: 'created', session: makeSession(id) })),
      fireResumed: (id: string) => managerSubs.forEach((s) => s({ kind: 'resumed', session: makeSession(id) })),
      fireStopped: (id: string) => managerSubs.forEach((s) => s({ kind: 'stopped', sessionId: id })),
    } as any,
    broker: {
      subscribe: (cb: (ev: unknown) => void) => { brokerSubs.push(cb); return () => { /* noop */ }; },
      firePending: (sessionId: string, request: any) =>
        brokerSubs.forEach((s) => s({ kind: 'pending', sessionId, request })),
    } as any,
    ws: {
      findByName: () => ({ chatId: 'c1', name: 'ws' }),
      getDefault: () => null,
    } as any,
    renderers: new Map([
      ['telegram', { renderNotification: () => ({ html: 'r' }) }],
    ]) as any,
    adapters: new Map([
      ['telegram', { canAddress: () => true, send: vi.fn().mockResolvedValue({ messageId: '1', success: true }) }],
    ]) as any,
    sessionSubs,
  };
}

describe('SessionFrontend (full renderer)', () => {
  it('subscribes on start; attaches on created; detaches on stopped', () => {
    const s = stubs();
    const f = new SessionFrontend({
      sessionManager: s.mgr, permissionBroker: s.broker, workspaceManager: s.ws,
      renderers: s.renderers, getAdapters: () => s.adapters,
    });
    f.start();
    s.mgr.fireCreated('sid-a');
    expect(s.sessionSubs.get('sid-a')?.length).toBe(1);
    s.mgr.fireStopped('sid-a');
    expect(s.sessionSubs.get('sid-a')?.length).toBe(0);
  });

  it('also attaches on resumed event', () => {
    const s = stubs();
    const f = new SessionFrontend({
      sessionManager: s.mgr, permissionBroker: s.broker, workspaceManager: s.ws,
      renderers: s.renderers, getAdapters: () => s.adapters,
    });
    f.start();
    s.mgr.fireResumed('sid-b');
    expect(s.sessionSubs.get('sid-b')?.length).toBe(1);
  });

  it('renders permission pending via renderers + adapter.send', async () => {
    const s = stubs();
    const f = new SessionFrontend({
      sessionManager: s.mgr, permissionBroker: s.broker, workspaceManager: s.ws,
      renderers: s.renderers, getAdapters: () => s.adapters,
    });
    f.start();
    // Make sure the session exists so resolveChannel returns a target
    s.mgr.fireCreated('sid');
    s.broker.firePending('sid', { id: 'sid:tu1', toolName: 'Bash', toolInput: {} });
    await new Promise((r) => setTimeout(r, 0));
    const adapter = s.adapters.get('telegram') as any;
    expect(adapter.send).toHaveBeenCalled();
  });

  it('forwards session events to adapter.send', async () => {
    const s = stubs();
    const f = new SessionFrontend({
      sessionManager: s.mgr, permissionBroker: s.broker, workspaceManager: s.ws,
      renderers: s.renderers, getAdapters: () => s.adapters,
    });
    f.start();
    s.mgr.fireCreated('sid-ev');
    const subs = s.sessionSubs.get('sid-ev')!;
    subs[0]({ kind: 'event', event: { kind: 'assistant_text', turnId: 't1', text: 'hi', complete: true } });
    await new Promise((r) => setTimeout(r, 0));
    const adapter = s.adapters.get('telegram') as any;
    expect(adapter.send).toHaveBeenCalled();
  });

  it('stop() releases all subscriptions', () => {
    const s = stubs();
    const f = new SessionFrontend({
      sessionManager: s.mgr, permissionBroker: s.broker, workspaceManager: s.ws,
      renderers: s.renderers, getAdapters: () => s.adapters,
    });
    f.start();
    s.mgr.fireCreated('sid-c');
    f.stop();
    expect(s.sessionSubs.get('sid-c')?.length).toBe(0);
  });
});
