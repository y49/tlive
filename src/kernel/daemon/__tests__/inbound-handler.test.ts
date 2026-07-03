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
  setTrust: vi.fn(),
  addAllowTool: vi.fn(),
  resolveReply: () => undefined,
  sessionInfo: () => undefined,
  listSessions: () => [],
  inject: vi.fn().mockResolvedValue(undefined),
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

  it('/trust on calls setTrust(true), /trust off calls setTrust(false)', async () => {
    const setTrust = vi.fn();
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter([]), setTrust }));
    await h.handle(envelope({ text: '/trust on' }));
    expect(setTrust).toHaveBeenCalledWith(true);
    await h.handle(envelope({ text: '/trust off' }));
    expect(setTrust).toHaveBeenCalledWith(false);
  });

  it('"pause:<id>" approves the in-hand request and sets trust', async () => {
    const setTrust = vi.fn();
    const permAnswer = vi.fn();
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter([]),
      setTrust,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'pause:REQ123' }));
    expect(setTrust).toHaveBeenCalledWith(true);
    expect(permAnswer).toHaveBeenCalledWith('REQ123', true);
  });
});

describe('reply-to routing & injection', () => {
  it('quoted reply to a wrapped session injects into its pty', async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      resolveReply: (ch, id) => (ch === 'telegram' && id === 'q1' ? '/repo' : undefined),
      sessionInfo: () => ({ kind: 'wrapped' as const, label: 'claude @ repo', sockPath: '/s.sock' }),
      inject,
    }));
    await h.handle(envelope({ text: '继续修测试', replyToMessageId: 'q1' }));
    expect(inject).toHaveBeenCalledWith('/s.sock', '继续修测试');
    expect(msgs.some((m) => m.text?.includes('已发送到'))).toBe(true);
  });

  it('quoted reply prefers a live continue over injection', async () => {
    const inject = vi.fn();
    const answer = vi.fn().mockReturnValue(true);
    const h = new InboundHandler(baseDeps({
      resolveReply: () => '/repo',
      sessionInfo: () => ({ kind: 'wrapped' as const, label: 'l', sockPath: '/s.sock', continueId: 'c9' }),
      continueBroker: { answer, request: vi.fn(), onRequest: vi.fn() } as never,
      inject,
    }));
    await h.handle(envelope({ text: 'go on', replyToMessageId: 'q1' }));
    expect(answer).toHaveBeenCalledWith('c9', 'go on');
    expect(inject).not.toHaveBeenCalled();
  });

  it('quoted reply to a hook-only session explains injection is unavailable', async () => {
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      resolveReply: () => '/repo',
      sessionInfo: () => ({ kind: 'hook' as const, label: 'proj' }),
    }));
    await h.handle(envelope({ text: 'hello', replyToMessageId: 'q1' }));
    expect(msgs.some((m) => m.text?.includes('无法注入'))).toBe(true);
  });

  it('bare text with exactly one wrapped session injects directly', async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      listSessions: () => [{ cwd: '/a', kind: 'wrapped' as const, label: 'only', sockPath: '/a.sock' }],
      inject,
    }));
    await h.handle(envelope({ text: 'do it' }));
    expect(inject).toHaveBeenCalledWith('/a.sock', 'do it');
  });

  it('bare text with multiple wrapped sessions asks to quote', async () => {
    const inject = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      listSessions: () => [
        { cwd: '/a', kind: 'wrapped' as const, label: 'a', sockPath: '/a.sock' },
        { cwd: '/b', kind: 'wrapped' as const, label: 'b', sockPath: '/b.sock' },
      ],
      inject,
    }));
    await h.handle(envelope({ text: 'do it' }));
    expect(inject).not.toHaveBeenCalled();
    expect(msgs.some((m) => m.text?.includes('引用'))).toBe(true);
  });

  it('allowtool:<rid>:<tool> grants the tool and approves the request', async () => {
    const addAllowTool = vi.fn();
    const permAnswer = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      addAllowTool,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as never,
    }));
    await h.handle(envelope({ text: 'allowtool:rid-1:Edit' }));
    expect(addAllowTool).toHaveBeenCalledWith('Edit');
    expect(permAnswer).toHaveBeenCalledWith('rid-1', true);
  });
});
