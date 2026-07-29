import { describe, it, expect, vi } from 'vitest';
import { InboundHandler, type InboundHandlerDeps } from '../inbound-handler.js';
import { SenderGuard } from '../sender-guard.js';
import { AskFlow } from '../ask-flow.js';
import { parseAskBatch } from '../../permission/ask-renderer.js';
import { createEditQueue } from '../edit-queue.js';
import type { IncomingEnvelope, IMAdapter, OutgoingMessage } from '../../contracts/im-adapter.js';
import type { PermissionRouter } from '../permission-router.js';
import type { ContinueBroker } from '../../permission/continue-broker.js';
import { STALE_CARD_NOTICE } from '../bootstrap.js';

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

const baseDeps = (over: Partial<InboundHandlerDeps> = {}): InboundHandlerDeps => {
  const editQueue = createEditQueue(); // fresh per test — mirrors bootstrap.ts's one shared instance
  return {
    senderGuard: new SenderGuard([]),
    imBy: () => undefined,
    permissionRouter: { answer: vi.fn(), requestPermission: vi.fn() } as unknown as PermissionRouter,
    continueBroker: { answer: vi.fn().mockReturnValue(false), request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
    takeLatestContinueId: () => null,
    setMuted: vi.fn(),
    setTrust: vi.fn(),
    setAutoApprove: vi.fn(),
    getMode: () => 'full',
    setMode: vi.fn(),
    addAllowTool: vi.fn(),
    resolveReply: () => undefined,
    sessionInfo: () => undefined,
    listSessions: () => [],
    inject: vi.fn().mockResolvedValue(undefined),
    findLiveCard: () => null,
    askFlow: new AskFlow(),
    repaintAsk: vi.fn(),
    ...over,
  };
};

/** The REAL AskFlow, seeded from raw tool input — no stub. A stubbed context
 *  lookup always returns the same value regardless of calls and so cannot
 *  catch "a bad click consumed the context" (review Minor 1); the real flow
 *  can, and it is pure in-memory logic with nothing to fake. */
function askFlowWith(entries: Record<string, unknown>): AskFlow {
  const flow = new AskFlow();
  for (const [rid, input] of Object.entries(entries)) flow.begin(rid, parseAskBatch(input)!, input);
  return flow;
}

const ONE = (question: string, ...labels: string[]) => ({ questions: [{ question, options: labels.map((label) => ({ label })) }] });
const ONE_MULTI = (question: string, ...labels: string[]) => ({ questions: [{ question, multiSelect: true, options: labels.map((label) => ({ label })) }] });

describe('InboundHandler', () => {
  it('approve:<id> answers true, sends no reply', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
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

  it('/help renders a styled card (inline-code command chips), not bare text, and never lists the retired /desktop', async () => {
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter(msgs) }));
    await h.handle(envelope({ text: '/help' }));
    expect(msgs).toHaveLength(1);
    const card = msgs[0] as { kind: string; title?: string; body?: string };
    expect(card.kind).toBe('card');
    expect(card.title).toContain('commands');
    expect(card.body).toContain('`/mute on|off`');
    expect(card.body).toContain('`/trust on|off`');
    expect(card.body).toContain('`/safe on|off`');
    expect(card.body).not.toContain('/desktop'); // machine-local, dropped from IM
  });

  it('/mute on mutes, /mute off unmutes (on = quiet)', async () => {
    const setMuted = vi.fn();
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter([]), setMuted }));
    await h.handle(envelope({ text: '/mute on' }));
    expect(setMuted).toHaveBeenLastCalledWith(true);
    await h.handle(envelope({ text: '/mute off' }));
    expect(setMuted).toHaveBeenLastCalledWith(false);
  });

  it('/safe on|off toggles auto-approve', async () => {
    const setAutoApprove = vi.fn();
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter([]), setAutoApprove }));
    await h.handle({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'm1', text: '/safe on', ts: 0 });
    expect(setAutoApprove).toHaveBeenCalledWith(true);
    await h.handle({ channel: 'telegram', chatId: 'c1', userId: 'u1', messageId: 'm2', text: '/safe off', ts: 0 });
    expect(setAutoApprove).toHaveBeenCalledWith(false);
  });

  it('/trust on calls setTrust(true), /trust off calls setTrust(false)', async () => {
    const setTrust = vi.fn();
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter([]), setTrust }));
    await h.handle(envelope({ text: '/trust on' }));
    expect(setTrust).toHaveBeenCalledWith(true);
    await h.handle(envelope({ text: '/trust off' }));
    expect(setTrust).toHaveBeenCalledWith(false);
  });

  it('a bare /mute (Telegram menu tap) replies with on/off buttons — never "Unknown command"', async () => {
    const msgs: Array<{ kind: string; text?: string; buttons?: Array<{ id: string; label: string }> }> = [];
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter(msgs) }));
    await h.handle(envelope({ text: '/mute' }));
    const card = msgs.find((m) => m.kind === 'card') as { buttons?: Array<{ id: string }> } | undefined;
    expect(card?.buttons?.map((b) => b.id)).toEqual(['set:mute:on', 'set:mute:off']);
    expect(msgs.some((m) => m.text === 'Unknown command — try /help.')).toBe(false);
  });

  it('a set:<which>:<on|off> button click drives the matching setter', async () => {
    const setMuted = vi.fn(); const setTrust = vi.fn(); const setAutoApprove = vi.fn();
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter([]), setMuted, setTrust, setAutoApprove }));
    await h.handle(envelope({ text: 'set:mute:on' }));
    expect(setMuted).toHaveBeenCalledWith(true);
    await h.handle(envelope({ text: 'set:trust:off' }));
    expect(setTrust).toHaveBeenCalledWith(false);
    await h.handle(envelope({ text: 'set:safe:on' }));
    expect(setAutoApprove).toHaveBeenCalledWith(true);
  });

  it('ask:<id>:<idx> answers with allow + updatedInput.answers carrying the picked option', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const h = new InboundHandler(baseDeps({
      askFlow: askFlowWith({ 'req-9': ONE('Pick a color?', 'Red', 'Blue') }),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:1' }));
    expect(permAnswer).toHaveBeenCalledTimes(1);
    const [rid, approved, message, updatedInput] = permAnswer.mock.calls[0];
    expect(rid).toBe('req-9');
    expect(approved).toBe(true); // allow, not deny
    expect(message).toBeUndefined();
    expect((updatedInput as { answers: Record<string, string> }).answers['Pick a color?']).toBe('Blue');
  });

  it('ask:<id>:<idx> replies with the stale-card notice when the context is gone (already answered/stale) — not a silent no-op', async () => {
    const permAnswer = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:1' }));
    expect(permAnswer).not.toHaveBeenCalled();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/no longer active/i);
  });

  it('an out-of-range index does not consume the context — a later legit index still answers (review Minor 1)', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const askFlow = askFlowWith({ 'req-9': ONE('Pick?', 'Red', 'Blue') });
    const h = new InboundHandler(baseDeps({
      askFlow,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:5' })); // out of range — must NOT eat the context
    expect(permAnswer).not.toHaveBeenCalled();
    expect(askFlow.peek('req-9')).toBeDefined(); // still there for a real pick

    await h.handle(envelope({ text: 'ask:req-9:1' })); // the legit follow-up click
    expect(permAnswer).toHaveBeenCalledTimes(1);
    expect((permAnswer.mock.calls[0][3] as { answers: Record<string, string> }).answers['Pick?']).toBe('Blue');
  });

  it('ask:<id>: (empty index) is a no-op, not a silent pick of option 0 — Number("") === 0 (review Minor 2)', async () => {
    const permAnswer = vi.fn();
    const askFlow = askFlowWith({ 'req-9': ONE('Pick?', 'Red', 'Blue') });
    const h = new InboundHandler(baseDeps({
      askFlow,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:' }));
    expect(permAnswer).not.toHaveBeenCalled();
    expect(askFlow.peek('req-9')).toBeDefined(); // not consumed either
  });

  it('ask:<id>:<idx> with a non-numeric index is a no-op', async () => {
    const permAnswer = vi.fn();
    const h = new InboundHandler(baseDeps({
      askFlow: askFlowWith({ 'req-9': ONE('Pick?', 'Red', 'Blue') }),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:abc' }));
    expect(permAnswer).not.toHaveBeenCalled();
  });

  it('askskip:<id> passes through with answer(rid, true) — not an auto-approve', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const askFlow = askFlowWith({ 'req-9': ONE('Pick?', 'Red', 'Blue') });
    const h = new InboundHandler(baseDeps({
      askFlow,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'askskip:req-9' }));
    expect(permAnswer).toHaveBeenCalledWith('req-9', true);
    expect(askFlow.peek('req-9')).toBeUndefined(); // freed, no leak
  });

  it('askskip: on a half-answered multi-question batch discards the lot — never a partial answer', async () => {
    const permAnswer = vi.fn().mockReturnValue(true);
    const askFlow = askFlowWith({ 'req-9': { questions: [
      { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Second?', options: [{ label: 'X' }, { label: 'Y' }] },
    ] } });
    const h = new InboundHandler(baseDeps({
      askFlow,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:0' }));   // answers First?, advances
    await h.handle(envelope({ text: 'askskip:req-9' }));
    expect(permAnswer).toHaveBeenCalledTimes(1);
    expect(permAnswer).toHaveBeenCalledWith('req-9', true); // bare pass-through, no updatedInput
    expect(askFlow.peek('req-9')).toBeUndefined();
  });

  it('askskip:<id> replies with the stale-card notice when the context is gone — symmetric with ask:/asktoggle:/asksubmit: peek-before-consume hardening (opus review); never touches answer() for the unconfirmed rid', async () => {
    const permAnswer = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'askskip:req-9' }));
    expect(permAnswer).not.toHaveBeenCalled(); // hardening intact: unconfirmed rid never reaches answer(rid, true)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/no longer active/i);
  });

  it('asktoggle:<id>:<idx> flips the selection and repaints every surface', async () => {
    const askFlow = askFlowWith({ 'req-1': ONE_MULTI('Pick colors?', 'Red', 'Blue') });
    const repaintAsk = vi.fn();
    const h = new InboundHandler(baseDeps({ askFlow, repaintAsk }));
    await h.handle(envelope({ text: 'asktoggle:req-1:1' }));
    expect(askFlow.peek('req-1')!.picks).toEqual([1]);
    expect(repaintAsk).toHaveBeenCalledWith('req-1');
  });

  for (const [name, text] of [['out-of-range', 'asktoggle:req-1:9'], ['non-numeric', 'asktoggle:req-1:abc'], ['single-select question', 'asktoggle:req-1:0']] as const) {
    it(`asktoggle: with a ${name} index is a no-op — no state change, no repaint`, async () => {
      const askFlow = askFlowWith({ 'req-1': name === 'single-select question' ? ONE('Q?', 'Red', 'Blue') : ONE_MULTI('Q?', 'Red', 'Blue') });
      const repaintAsk = vi.fn();
      const h = new InboundHandler(baseDeps({ askFlow, repaintAsk }));
      await h.handle(envelope({ text }));
      expect(askFlow.peek('req-1')!.picks).toEqual([]);
      expect(repaintAsk).not.toHaveBeenCalled();
    });
  }

  it('asktoggle: for an unknown/expired requestId is a no-op', async () => {
    const repaintAsk = vi.fn();
    const h = new InboundHandler(baseDeps({ repaintAsk }));
    await h.handle(envelope({ text: 'asktoggle:gone:0' }));
    expect(repaintAsk).not.toHaveBeenCalled();
  });

  it('asksubmit:<id> with nothing selected is a no-op — never answers with an empty selection', async () => {
    const permAnswer = vi.fn();
    const h = new InboundHandler(baseDeps({
      askFlow: askFlowWith({ 'req-1': ONE_MULTI('Q?', 'Red', 'Blue') }),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'asksubmit:req-1' }));
    expect(permAnswer).not.toHaveBeenCalled();
  });

  it('asksubmit:<id> answers with every picked label and frees the request', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const askFlow = askFlowWith({ 'req-1': ONE_MULTI('Pick colors?', 'Red', 'Blue') });
    const h = new InboundHandler(baseDeps({
      askFlow,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'asktoggle:req-1:0' }));
    await h.handle(envelope({ text: 'asktoggle:req-1:1' }));
    await h.handle(envelope({ text: 'asksubmit:req-1' }));
    expect(permAnswer).toHaveBeenCalledTimes(1);
    const [rid, approved, , updatedInput] = permAnswer.mock.calls[0];
    expect(rid).toBe('req-1');
    expect(approved).toBe(true); // allow + updatedInput
    expect((updatedInput as { answers: Record<string, string> }).answers['Pick colors?']).toBe('Red, Blue');
    expect(askFlow.peek('req-1')).toBeUndefined(); // consumed, no leak
  });

  it('asksubmit: for an unknown/expired requestId replies with the stale-card notice — not a silent no-op', async () => {
    const permAnswer = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'asksubmit:gone' }));
    expect(permAnswer).not.toHaveBeenCalled();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/no longer active/i);
  });

  describe('multi-question batches', () => {
    const THREE = { questions: [
      { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Second?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
      { question: 'Third?', options: [{ label: 'P' }, { label: 'Q' }] },
    ] };

    it('walks the whole batch and answers ONCE, with every question answered', async () => {
      const permAnswer = vi.fn().mockReturnValue(true);
      const repaintAsk = vi.fn();
      const askFlow = askFlowWith({ 'r': THREE });
      const h = new InboundHandler(baseDeps({
        askFlow, repaintAsk,
        permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
      }));
      await h.handle(envelope({ text: 'ask:r:0' }));         // First? -> A
      expect(permAnswer).not.toHaveBeenCalled();             // NOT answered yet
      await h.handle(envelope({ text: 'asktoggle:r:1' }));
      await h.handle(envelope({ text: 'asksubmit:r' }));     // Second? -> Y
      expect(permAnswer).not.toHaveBeenCalled();
      await h.handle(envelope({ text: 'ask:r:1' }));         // Third? -> Q

      expect(permAnswer).toHaveBeenCalledTimes(1);
      expect((permAnswer.mock.calls[0][3] as { answers: Record<string, string> }).answers)
        .toEqual({ 'First?': 'A', 'Second?': 'Y', 'Third?': 'Q' });
      expect(repaintAsk).toHaveBeenCalledWith('r');          // surfaces followed the cursor
    });

    it('askback: re-asks the previous question and drops its answer', async () => {
      const permAnswer = vi.fn().mockReturnValue(true);
      const askFlow = askFlowWith({ 'r': THREE });
      const h = new InboundHandler(baseDeps({
        askFlow,
        permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
      }));
      await h.handle(envelope({ text: 'ask:r:0' }));         // First? -> A (a misclick)
      await h.handle(envelope({ text: 'askback:r' }));
      expect(askFlow.peek('r')!.cursor).toBe(0);
      await h.handle(envelope({ text: 'ask:r:1' }));         // First? -> B instead
      await h.handle(envelope({ text: 'asktoggle:r:0' }));
      await h.handle(envelope({ text: 'asksubmit:r' }));
      await h.handle(envelope({ text: 'ask:r:0' }));
      expect((permAnswer.mock.calls[0][3] as { answers: Record<string, string> }).answers['First?']).toBe('B');
    });

    it('askback: on the first question is a no-op, and on an unknown request reports stale', async () => {
      const repaintAsk = vi.fn();
      const msgs: Array<{ kind: string; text?: string }> = [];
      const h = new InboundHandler(baseDeps({ askFlow: askFlowWith({ 'r': THREE }), repaintAsk, imBy: () => makeAdapter(msgs) }));
      await h.handle(envelope({ text: 'askback:r' }));
      expect(repaintAsk).not.toHaveBeenCalled();
      expect(msgs).toHaveLength(0);

      await h.handle(envelope({ text: 'askback:gone' }));
      expect(msgs).toHaveLength(1);
      expect(msgs[0].text).toMatch(/no longer active/i);
    });
  });

  it('tells the user when a stale card button is tapped instead of silently ignoring it', async () => {
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      permissionRouter: { answer: () => false, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'approve:dead-request-id' }));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/no longer active/i);
  });

  it('"pause:<id>" approves the in-hand request and sets trust', async () => {
    const setTrust = vi.fn();
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
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
    expect(msgs.some((m) => m.text?.includes('Sent to'))).toBe(true);
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

  // The payload is requestId-only: Telegram caps callback_data at 64 bytes and
  // rejects the whole card if a button is over, which `:<toolName>` was for every
  // name longer than 17 characters. The name is resolved from the pending request.
  it('allowtool:<rid> grants the tool named by the pending request and approves it', async () => {
    const addAllowTool = vi.fn();
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      addAllowTool,
      permissionRouter: {
        answer: permAnswer,
        requestPermission: vi.fn(),
        toolNameFor: (rid: string) => (rid === 'rid-1' ? 'mcp__codegraph__codegraph_status' : undefined),
      } as never,
    }));
    await h.handle(envelope({ text: 'allowtool:rid-1' }));
    expect(addAllowTool).toHaveBeenCalledWith('mcp__codegraph__codegraph_status');
    expect(permAnswer).toHaveBeenCalledWith('rid-1', true);
  });

  it('allowtool: for a request that is already gone grants nothing and says the card is stale', async () => {
    const addAllowTool = vi.fn();
    const permAnswer = vi.fn().mockReturnValue(false);
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      addAllowTool,
      permissionRouter: {
        answer: permAnswer,
        requestPermission: vi.fn(),
        toolNameFor: () => undefined,
      } as never,
    }));
    await h.handle(envelope({ text: 'allowtool:rid-gone' }));
    // Nothing to grant: without the payload suffix there is no way to know which
    // tool a dead card meant, and guessing would hand out a standing allow.
    expect(addAllowTool).not.toHaveBeenCalled();
    expect(permAnswer).not.toHaveBeenCalled();
    expect(msgs.some((m) => (m.text ?? '').length > 0)).toBe(true);
  });
});

describe('quoting a live ASK card = free-form answer (the remote "Type something")', () => {
  it('single-select: quoted text becomes the ask answer via allow + updatedInput (not a bare deny reason)', async () => {
    const answers: Array<{ rid: string; approved: boolean; updatedInput?: unknown }> = [];
    const askFlow = askFlowWith({ 'req-1': ONE('Pick a color?', 'Red', 'Blue') });
    const h = new InboundHandler(baseDeps({
      findLiveCard: () => 'req-1',
      askFlow,
      permissionRouter: {
        answer: (rid: string, approved: boolean, _m?: string, updatedInput?: unknown) => { answers.push({ rid, approved, updatedInput }); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'a warm orange, actually', replyToMessageId: 'card-msg-1' }));
    expect(answers).toHaveLength(1);
    expect(answers[0].approved).toBe(true); // allow, not deny
    expect((answers[0].updatedInput as { answers: Record<string, string> }).answers['Pick a color?']).toBe('a warm orange, actually');
    expect(askFlow.peek('req-1')).toBeUndefined(); // consumed, single-use
  });

  it('multi-select: ticked boxes ride along with the typed text', async () => {
    const answers: Array<{ updatedInput?: unknown }> = [];
    const askFlow = askFlowWith({ 'req-1': ONE_MULTI('Channels?', 'Feishu', 'Telegram') });
    const h = new InboundHandler(baseDeps({
      findLiveCard: () => 'req-1',
      askFlow,
      permissionRouter: {
        answer: (_r: string, _a: boolean, _m?: string, updatedInput?: unknown) => { answers.push({ updatedInput }); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    }));
    askFlow.toggle('req-1', 1); // Telegram ticked
    await h.handle(envelope({ text: 'and email please', replyToMessageId: 'card-msg-1' }));
    expect((answers[0].updatedInput as { answers: Record<string, string> }).answers['Channels?']).toBe('Telegram, and email please');
  });
});

describe('native input box submits (Feishu form → formText)', () => {
  it('askinput:<rid> + formText answers the ask with picks merged in', async () => {
    const answers: Array<{ updatedInput?: unknown }> = [];
    const askFlow = askFlowWith({ 'req-1': ONE_MULTI('Channels?', 'Feishu', 'Telegram') });
    const h = new InboundHandler(baseDeps({
      askFlow,
      permissionRouter: {
        answer: (_r: string, _a: boolean, _m?: string, updatedInput?: unknown) => { answers.push({ updatedInput }); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    }));
    askFlow.toggle('req-1', 0);
    await h.handle(envelope({ text: 'askinput:req-1', formText: 'and email' }));
    expect((answers[0].updatedInput as { answers: Record<string, string> }).answers['Channels?']).toBe('Feishu, and email');
    expect(askFlow.peek('req-1')).toBeUndefined(); // consumed
  });

});

describe('quoting a live approval card = deny with guidance', () => {
  it('sends the quoted text to the agent as the denial reason', async () => {
    const answers: Array<{ rid: string; approved: boolean; message?: string }> = [];
    const h = new InboundHandler(baseDeps({
      findLiveCard: (_ch: string, mid: string) => (mid === 'card-msg-1' ? 'req-1' : null),
      permissionRouter: {
        answer: (rid: string, approved: boolean, message?: string) => { answers.push({ rid, approved, message }); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'Do not use rm -rf, move it to /tmp instead', replyToMessageId: 'card-msg-1' }));
    expect(answers).toEqual([{ rid: 'req-1', approved: false, message: 'Do not use rm -rf, move it to /tmp instead' }]);
  });

  it('takes priority over continue/inject routing', async () => {
    const answers: string[] = [];
    const continued: string[] = [];
    const injected = vi.fn();
    const h = new InboundHandler(baseDeps({
      findLiveCard: () => 'req-1',
      permissionRouter: {
        answer: (rid: string) => { answers.push(rid); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
      continueBroker: { answer: (id: string) => { continued.push(id); return true; }, request: vi.fn(), onRequest: vi.fn() } as unknown as ContinueBroker,
      // Even if reply-routing WOULD resolve to a wrapped session, the live-card
      // check must short-circuit before any of that is consulted.
      resolveReply: () => '/repo',
      sessionInfo: () => ({ kind: 'wrapped' as const, label: 'l', sockPath: '/s.sock', continueId: 'c9' }),
      inject: injected,
    }));
    await h.handle(envelope({ text: 'use mv', replyToMessageId: 'card-msg-1' }));
    expect(answers).toEqual(['req-1']);
    expect(continued).toEqual([]); // 引用审批卡 = 答那次审批,不是给会话发闲话
    expect(injected).not.toHaveBeenCalled();
  });

  it('quoting a card that is no longer live falls through to the stale/not-found notice', async () => {
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      findLiveCard: () => null, // 已结算/已 stale
      resolveReply: () => undefined,
    }));
    await h.handle(envelope({ text: 'use mv', replyToMessageId: 'dead-card' }));
    expect(msgs.some((m) => m.text && /no longer active|引用/i.test(m.text))).toBe(true);
  });

  it('a live-card hit that the router reports as stale (race) replies with the shared STALE_CARD_NOTICE, not a second wording', async () => {
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      findLiveCard: () => 'req-1',
      permissionRouter: { answer: () => false, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'use mv', replyToMessageId: 'card-msg-1' }));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/no longer active/i);
  });

  it('never approves via the quoted-reply path — findLiveCard hit always answers with approved:false', async () => {
    const calls: Array<{ approved: boolean }> = [];
    const h = new InboundHandler(baseDeps({
      findLiveCard: () => 'req-1',
      permissionRouter: {
        answer: (_rid: string, approved: boolean) => { calls.push({ approved }); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'please allow this', replyToMessageId: 'card-msg-1' }));
    expect(calls).toEqual([{ approved: false }]);
  });
});

describe('attachment injection', () => {
  it('quoted reply with attachments injects caption + local paths', async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      resolveReply: () => '/repo',
      sessionInfo: () => ({ kind: 'wrapped' as const, label: 'l', sockPath: '/s.sock' }),
      inject,
    }));
    await h.handle(envelope({
      text: '看看这张报错截图',
      replyToMessageId: 'q1',
      attachments: [{ name: 'err.png', mime: 'image/png', localPath: '/home/u/.tlive/inbox/ab-err.png', sizeBytes: 12345 }],
    }));
    expect(inject).toHaveBeenCalledWith('/s.sock', '看看这张报错截图\n/home/u/.tlive/inbox/ab-err.png');
    expect(msgs.some((m) => m.text?.includes('1 attachment path'))).toBe(true);
  });

  it('attachment-only message (no caption) still injects the path, skips continue', async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const answer = vi.fn().mockReturnValue(true);
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter([]),
      resolveReply: () => '/repo',
      sessionInfo: () => ({ kind: 'wrapped' as const, label: 'l', sockPath: '/s.sock', continueId: 'c1' }),
      continueBroker: { answer, request: vi.fn(), onRequest: vi.fn() } as never,
      inject,
    }));
    await h.handle(envelope({
      text: '',
      replyToMessageId: 'q1',
      attachments: [{ name: 'a.png', mime: 'image/png', localPath: '/inbox/a.png', sizeBytes: 1 }],
    }));
    expect(answer).not.toHaveBeenCalled(); // empty continue reply is meaningless
    expect(inject).toHaveBeenCalledWith('/s.sock', '/inbox/a.png');
  });

  it('empty text without attachments is dropped silently', async () => {
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter(msgs) }));
    await h.handle(envelope({ text: '' }));
    expect(msgs).toHaveLength(0);
  });
});

describe('handback: callback (Answer at the terminal instead)', () => {
  it('hands the request back and says so', async () => {
    const handBack = vi.fn().mockReturnValue(true);
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      permissionRouter: { handBack, answer: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'handback:req-1' }));
    expect(handBack).toHaveBeenCalledWith('req-1');
    expect(msgs[0].text).toMatch(/terminal/i);
  });

  it('a stale handback says so instead of going silent', async () => {
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      permissionRouter: { handBack: vi.fn().mockReturnValue(false), answer: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'handback:gone' }));
    expect(msgs[0].text).toBe(STALE_CARD_NOTICE);
  });
});

describe('/mode from IM', () => {
  it('a typed rung writes the posture and reports the transition', async () => {
    const setMode = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter(msgs), getMode: () => 'full', setMode }));
    await h.handle(envelope({ text: '/mode all' }));
    expect(setMode).toHaveBeenCalledWith('all');
    expect(msgs[0].text).toContain('full → all');
  });

  it('the mode:<level> button goes through the same setter', async () => {
    const setMode = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter(msgs), getMode: () => 'notify', setMode }));
    await h.handle(envelope({ text: 'mode:full' }));
    expect(setMode).toHaveBeenCalledWith('full');
  });

  it('an unknown level in a callback is ignored, not applied', async () => {
    const setMode = vi.fn();
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter([]), setMode }));
    await h.handle(envelope({ text: 'mode:root' }));
    expect(setMode).not.toHaveBeenCalled();
  });

  it('bare /mode replies with the four rungs and marks the current one', async () => {
    const msgs: Array<{ kind: string; body?: string; buttons?: Array<{ id: string; label: string }> }> = [];
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter(msgs as Array<{ kind: string; text?: string }>), getMode: () => 'full' }));
    await h.handle(envelope({ text: '/mode' }));
    expect(msgs[0].kind).toBe('card');
    expect(msgs[0].buttons?.map((b) => b.id)).toEqual(['mode:off', 'mode:notify', 'mode:full', 'mode:all']);
    expect(msgs[0].buttons?.find((b) => b.id === 'mode:full')?.label).toMatch(/current/i);
  });
});
