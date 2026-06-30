import { describe, it, expect, vi } from 'vitest';
import { InboundHandler, type InboundHandlerDeps } from '../inbound-handler.js';
import { SenderGuard } from '../sender-guard.js';
import type { IncomingEnvelope, IMAdapter } from '../../contracts/im-adapter.js';
import type { PermissionRouter } from '../permission-router.js';
import type { ContinueBroker } from '../../permission/continue-broker.js';

const envelope = (over: Partial<IncomingEnvelope> = {}): IncomingEnvelope => ({
  channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'm1', text: '', ts: 0, ...over,
});

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

const baseDeps = (over: Partial<InboundHandlerDeps> = {}): InboundHandlerDeps => ({
  senderGuard: new SenderGuard([]),
  imBy: () => undefined,
  permissionRouter: { answer: vi.fn(), requestPermission: vi.fn() } as unknown as PermissionRouter,
  continueBroker: { answer: vi.fn().mockReturnValue(false), request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
  takeLatestContinueId: () => null,
  setMuted: vi.fn(),
  ...over,
});

describe('InboundHandler', () => {
  it('approve:<id> answers true, sends no reply', async () => {
    const permAnswer = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'approve:req-1' }));
    expect(permAnswer).toHaveBeenCalledWith('req-1', true);
    expect(msgs).toHaveLength(0);
  });

  it('drops input from an unauthorized sender', async () => {
    const permAnswer = vi.fn();
    const h = new InboundHandler(baseDeps({
      senderGuard: new SenderGuard([{ channel: 'telegram', userId: 'u1' }]),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ userId: 'evil', text: 'approve:x' }));
    expect(permAnswer).not.toHaveBeenCalled();
  });

  it('stale continueId falls through to help, not silent drop', async () => {
    const brokerAnswer = vi.fn().mockReturnValue(false);
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      continueBroker: { answer: brokerAnswer, request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
      takeLatestContinueId: () => 'stale-id',
    }));
    await h.handle(envelope({ text: 'free text' }));
    expect(brokerAnswer).toHaveBeenCalledWith('stale-id', 'free text');
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { text: string }).text).toContain('tlive');
  });

  it('live continueId consumed without help', async () => {
    const brokerAnswer = vi.fn().mockReturnValue(true);
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      continueBroker: { answer: brokerAnswer, request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
      takeLatestContinueId: () => 'live-id',
    }));
    await h.handle(envelope({ text: 'run tests' }));
    expect(brokerAnswer).toHaveBeenCalledWith('live-id', 'run tests');
    expect(msgs).toHaveLength(0);
  });

  it('/perm off mutes', async () => {
    const setMuted = vi.fn();
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter([]), setMuted }));
    await h.handle(envelope({ text: '/perm off' }));
    expect(setMuted).toHaveBeenCalledWith(true);
  });
});
