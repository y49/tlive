// Tests for InboundHandler — findings 2 and 4.

import { describe, it, expect, vi } from 'vitest';
import { InboundHandler } from '../inbound-handler.js';
import type { IncomingEnvelope, IMAdapter } from '../../contracts/im-adapter.js';
import type { ChatRouter } from '../../workspace/chat-router.js';
import type { WorkspaceRegistry } from '../../workspace/registry.js';
import type { PermissionRouter } from '../permission-router.js';
import type { ContinueBroker } from '../../permission/continue-broker.js';

const envelope = (over: Partial<IncomingEnvelope> = {}): IncomingEnvelope => ({
  channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'm1',
  text: '', ts: 0, ...over,
});

/** Minimal IMAdapter mock that records sent messages. */
function makeAdapter(msgs: Array<{ kind: string; text?: string }>): IMAdapter {
  return {
    channel: 'telegram',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockImplementation((msg) => { msgs.push(msg); return Promise.resolve({ messageId: 'r1' }); }),
    edit: vi.fn().mockResolvedValue(undefined),
    onInbound: vi.fn(),
    isConnected: vi.fn().mockReturnValue('connected' as const),
  };
}

describe('InboundHandler — finding 2: callback before unbound early-exit', () => {
  it('approve:<id> from an unbound chat calls permissionRouter.answer(id, true)', async () => {
    const permAnswer = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const adapter = makeAdapter(msgs);

    const handler = new InboundHandler({
      router: {
        route: () => ({ kind: 'unbound', chatKey: 'telegram:c1' }),
        bind: vi.fn(),
        snapshot: vi.fn(),
      } as unknown as ChatRouter,
      workspaces: { list: () => [], lookupByCwd: vi.fn() } as unknown as WorkspaceRegistry,
      imBy: () => adapter,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
      continueBroker: { answer: vi.fn().mockReturnValue(false), request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
      latestContinueId: new Map(),
    });

    await handler.handle(envelope({ text: 'approve:test-req-id' }));

    expect(permAnswer).toHaveBeenCalledWith('test-req-id', true);
    // No "unbound" reply sent — we returned early after answering the callback.
    expect(msgs).toHaveLength(0);
  });

  it('deny:<id> from an unbound chat calls permissionRouter.answer(id, false)', async () => {
    const permAnswer = vi.fn();

    const handler = new InboundHandler({
      router: {
        route: () => ({ kind: 'unbound', chatKey: 'telegram:c1' }),
        bind: vi.fn(),
        snapshot: vi.fn(),
      } as unknown as ChatRouter,
      workspaces: { list: () => [], lookupByCwd: vi.fn() } as unknown as WorkspaceRegistry,
      imBy: () => undefined,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
      continueBroker: { answer: vi.fn().mockReturnValue(false), request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
      latestContinueId: new Map(),
    });

    await handler.handle(envelope({ text: 'deny:another-id' }));
    expect(permAnswer).toHaveBeenCalledWith('another-id', false);
  });
});

describe('InboundHandler — finding 4: stale continueId falls through to help', () => {
  it('free text after timeout (answer returns false) produces help hint, not silent drop', async () => {
    const brokerAnswer = vi.fn().mockReturnValue(false); // stale — not in pending
    const msgs: Array<{ kind: string; text?: string }> = [];
    const adapter = makeAdapter(msgs);

    const handler = new InboundHandler({
      router: {
        route: () => ({ kind: 'route', workspaceId: 'ws1' }),
        bind: vi.fn(),
        snapshot: vi.fn(),
      } as unknown as ChatRouter,
      workspaces: { list: () => [], lookupByCwd: vi.fn() } as unknown as WorkspaceRegistry,
      imBy: () => adapter,
      permissionRouter: { answer: vi.fn(), requestPermission: vi.fn() } as unknown as PermissionRouter,
      continueBroker: { answer: brokerAnswer, request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
      latestContinueId: new Map([['ws1', 'stale-request-id']]),
    });

    await handler.handle(envelope({ text: 'some free text after timeout' }));

    // broker.answer was called with the stale id
    expect(brokerAnswer).toHaveBeenCalledWith('stale-request-id', 'some free text after timeout');
    // Message was NOT silently dropped — help hint was sent
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { kind: string; text: string }).text).toContain('tlive v2');
  });

  it('free text with live continueId (answer returns true) is consumed without help hint', async () => {
    const brokerAnswer = vi.fn().mockReturnValue(true); // live
    const msgs: Array<{ kind: string; text?: string }> = [];
    const adapter = makeAdapter(msgs);

    const handler = new InboundHandler({
      router: {
        route: () => ({ kind: 'route', workspaceId: 'ws1' }),
        bind: vi.fn(),
        snapshot: vi.fn(),
      } as unknown as ChatRouter,
      workspaces: { list: () => [], lookupByCwd: vi.fn() } as unknown as WorkspaceRegistry,
      imBy: () => adapter,
      permissionRouter: { answer: vi.fn(), requestPermission: vi.fn() } as unknown as PermissionRouter,
      continueBroker: { answer: brokerAnswer, request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
      latestContinueId: new Map([['ws1', 'live-request-id']]),
    });

    await handler.handle(envelope({ text: 'run tests please' }));

    expect(brokerAnswer).toHaveBeenCalledWith('live-request-id', 'run tests please');
    // No help hint when the continue request was live
    expect(msgs).toHaveLength(0);
  });
});
