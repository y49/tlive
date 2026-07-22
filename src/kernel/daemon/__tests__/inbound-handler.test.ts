import { describe, it, expect, vi } from 'vitest';
import { InboundHandler, type InboundHandlerDeps } from '../inbound-handler.js';
import { SenderGuard } from '../sender-guard.js';
import { AskSelection } from '../ask-state.js';
import { createEditQueue } from '../edit-queue.js';
import type { IncomingEnvelope, IMAdapter, OutgoingMessage } from '../../contracts/im-adapter.js';
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
    addAllowTool: vi.fn(),
    resolveReply: () => undefined,
    sessionInfo: () => undefined,
    listSessions: () => [],
    inject: vi.fn().mockResolvedValue(undefined),
    findLiveCard: () => null,
    peekAskContext: () => undefined,
    takeAskContext: () => undefined,
    askSelection: new AskSelection(),
    getAskCards: () => [],
    queueEdit: (rid, fn) => editQueue.enqueue(rid, fn),
    ...over,
  };
};

/** A real get-and-clear store (mirrors bootstrap.ts's askContexts Map) so tests
 *  can observe whether a bad `ask:` click actually consumed the context —
 *  a plain `takeAskContext: () => ({...})` stub (as the old tests used) always
 *  returns the same value regardless of calls and can't catch that regression
 *  (review Minor 1). */
function makeAskStore(entries: Record<string, { question: string; options: Array<{ label: string; description?: string }> }>) {
  const map = new Map(Object.entries(entries));
  return {
    peekAskContext: (rid: string) => map.get(rid),
    takeAskContext: (rid: string) => {
      const v = map.get(rid);
      if (v) map.delete(rid);
      return v;
    },
  };
}

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

  it('/perm off mutes', async () => {
    const setMuted = vi.fn();
    const h = new InboundHandler(baseDeps({ imBy: () => makeAdapter([]), setMuted }));
    await h.handle(envelope({ text: '/perm off' }));
    expect(setMuted).toHaveBeenCalledWith(true);
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

  it('ask:<id>:<idx> answers with allow + updatedInput.answers carrying the picked option', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const h = new InboundHandler(baseDeps({
      ...makeAskStore({ 'req-9': { question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] } }),
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
      peekAskContext: () => undefined,
      takeAskContext: () => undefined,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:1' }));
    expect(permAnswer).not.toHaveBeenCalled();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/no longer active/i);
  });

  it('an out-of-range index does not consume the context — a later legit index still answers (review Minor 1)', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const store = makeAskStore({ 'req-9': { question: 'Pick?', options: [{ label: 'Red' }, { label: 'Blue' }] } });
    const h = new InboundHandler(baseDeps({
      ...store,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:5' })); // out of range — must NOT eat the context
    expect(permAnswer).not.toHaveBeenCalled();
    expect(store.peekAskContext('req-9')).toBeDefined(); // still there for a real pick

    await h.handle(envelope({ text: 'ask:req-9:1' })); // the legit follow-up click
    expect(permAnswer).toHaveBeenCalledTimes(1);
    const [rid, approved, , updatedInput] = permAnswer.mock.calls[0];
    expect(rid).toBe('req-9');
    expect(approved).toBe(true);
    expect((updatedInput as { answers: Record<string, string> }).answers['Pick?']).toBe('Blue');
  });

  it('ask:<id>: (empty index) is a no-op, not a silent pick of option 0 — Number("") === 0 (review Minor 2)', async () => {
    const permAnswer = vi.fn();
    const store = makeAskStore({ 'req-9': { question: 'Pick?', options: [{ label: 'Red' }, { label: 'Blue' }] } });
    const h = new InboundHandler(baseDeps({
      ...store,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:' }));
    expect(permAnswer).not.toHaveBeenCalled();
    expect(store.peekAskContext('req-9')).toBeDefined(); // not consumed either
  });

  it('ask:<id>:<idx> with a non-numeric index is a no-op', async () => {
    const permAnswer = vi.fn();
    const store = makeAskStore({ 'req-9': { question: 'Pick?', options: [{ label: 'Red' }, { label: 'Blue' }] } });
    const h = new InboundHandler(baseDeps({
      ...store,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'ask:req-9:abc' }));
    expect(permAnswer).not.toHaveBeenCalled();
  });

  it('askskip:<id> passes through with answer(rid, true) — not an auto-approve', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const takeAskContext = vi.fn().mockReturnValue({ question: 'Pick?', options: [{ label: 'Red' }, { label: 'Blue' }] });
    const h = new InboundHandler(baseDeps({
      peekAskContext: () => ({ question: 'Pick?', options: [{ label: 'Red' }, { label: 'Blue' }] }),
      takeAskContext,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'askskip:req-9' }));
    expect(takeAskContext).toHaveBeenCalledWith('req-9');
    expect(permAnswer).toHaveBeenCalledWith('req-9', true);
  });

  it('askskip:<id> also frees any multi-select picks — no AskSelection leak (Task 10)', async () => {
    const askSelection = new AskSelection();
    askSelection.toggle('req-9', 0);
    const h = new InboundHandler(baseDeps({
      peekAskContext: () => ({ question: 'Pick?', options: [{ label: 'Red' }, { label: 'Blue' }] }),
      takeAskContext: vi.fn().mockReturnValue({ question: 'Pick?', options: [{ label: 'Red' }, { label: 'Blue' }] }),
      askSelection,
      permissionRouter: { answer: vi.fn(), requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'askskip:req-9' }));
    expect(askSelection.selected('req-9')).toEqual([]);
  });

  it('askskip:<id> replies with the stale-card notice when the context is gone — symmetric with ask:/asktoggle:/asksubmit: peek-before-consume hardening (opus review); never touches answer() for the unconfirmed rid', async () => {
    const permAnswer = vi.fn();
    const takeAskContext = vi.fn();
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      peekAskContext: () => undefined,
      takeAskContext,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'askskip:req-9' }));
    expect(permAnswer).not.toHaveBeenCalled(); // hardening intact: unconfirmed rid never reaches answer(rid, true)
    expect(takeAskContext).not.toHaveBeenCalled();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/no longer active/i);
  });

  it('asktoggle:<id>:<idx> flips the selection and edits every sent card with refreshed checkboxes + Submit(N) (Task 10)', async () => {
    const askSelection = new AskSelection();
    const edits: Array<{ messageId: string; msg: OutgoingMessage }> = [];
    const edit = vi.fn().mockImplementation((messageId: string, msg: OutgoingMessage) => { edits.push({ messageId, msg }); return Promise.resolve(); });
    const h = new InboundHandler(baseDeps({
      ...makeAskStore({ 'req-1': { question: 'Pick colors?', options: [{ label: 'Red' }, { label: 'Blue' }] } }),
      askSelection,
      getAskCards: (rid) => (rid === 'req-1' ? [{ channel: 'telegram', messageId: 'm1', title: 'Question', body: 'Pick colors?' }] : []),
      imBy: () => ({ ...makeAdapter([]), edit }),
    }));
    await h.handle(envelope({ text: 'asktoggle:req-1:1' }));
    expect(askSelection.selected('req-1')).toEqual([1]);
    expect(edits).toHaveLength(1);
    expect(edits[0].messageId).toBe('m1');
    const card = edits[0].msg as { kind: 'card'; buttons?: Array<{ id: string; label: string }> };
    expect(card.buttons).toEqual([
      { id: 'asktoggle:req-1:0', label: '▢ Red' },
      { id: 'asktoggle:req-1:1', label: '▣ Blue' },
      { id: 'asksubmit:req-1', label: 'Submit (1)' },
      { id: 'askskip:req-1', label: 'Skip' },
    ]);
  });

  it('asktoggle: with an out-of-range index is a no-op — no state change, no card edit', async () => {
    const askSelection = new AskSelection();
    const edit = vi.fn();
    const h = new InboundHandler(baseDeps({
      ...makeAskStore({ 'req-1': { question: 'Q?', options: [{ label: 'Red' }, { label: 'Blue' }] } }),
      askSelection,
      getAskCards: () => [{ channel: 'telegram', messageId: 'm1', title: 't', body: 'b' }],
      imBy: () => ({ ...makeAdapter([]), edit }),
    }));
    await h.handle(envelope({ text: 'asktoggle:req-1:9' }));
    expect(askSelection.selected('req-1')).toEqual([]);
    expect(edit).not.toHaveBeenCalled();
  });

  it('asktoggle: with a non-numeric index is a no-op', async () => {
    const askSelection = new AskSelection();
    const edit = vi.fn();
    const h = new InboundHandler(baseDeps({
      ...makeAskStore({ 'req-1': { question: 'Q?', options: [{ label: 'Red' }, { label: 'Blue' }] } }),
      askSelection,
      getAskCards: () => [{ channel: 'telegram', messageId: 'm1', title: 't', body: 'b' }],
      imBy: () => ({ ...makeAdapter([]), edit }),
    }));
    await h.handle(envelope({ text: 'asktoggle:req-1:abc' }));
    expect(askSelection.selected('req-1')).toEqual([]);
    expect(edit).not.toHaveBeenCalled();
  });

  it('asktoggle: for an unknown/expired requestId is a no-op', async () => {
    const askSelection = new AskSelection();
    const edit = vi.fn();
    const h = new InboundHandler(baseDeps({
      askSelection,
      getAskCards: () => [{ channel: 'telegram', messageId: 'm1', title: 't', body: 'b' }],
      imBy: () => ({ ...makeAdapter([]), edit }),
    }));
    await h.handle(envelope({ text: 'asktoggle:gone:0' }));
    expect(askSelection.selected('gone')).toEqual([]);
    expect(edit).not.toHaveBeenCalled();
  });

  it('asksubmit:<id> with nothing selected is a no-op — never answers with an empty selection', async () => {
    const permAnswer = vi.fn();
    const h = new InboundHandler(baseDeps({
      ...makeAskStore({ 'req-1': { question: 'Q?', options: [{ label: 'Red' }, { label: 'Blue' }] } }),
      askSelection: new AskSelection(),
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'asksubmit:req-1' }));
    expect(permAnswer).not.toHaveBeenCalled();
  });

  it('asksubmit:<id> answers deny+message with every picked label, consumes the context, and frees the selection', async () => {
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
    const askSelection = new AskSelection();
    askSelection.toggle('req-1', 0);
    askSelection.toggle('req-1', 1);
    const store = makeAskStore({ 'req-1': { question: 'Pick colors?', options: [{ label: 'Red' }, { label: 'Blue' }] } });
    const h = new InboundHandler(baseDeps({
      ...store,
      askSelection,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'asksubmit:req-1' }));
    expect(permAnswer).toHaveBeenCalledTimes(1);
    const [rid, approved, , updatedInput] = permAnswer.mock.calls[0];
    expect(rid).toBe('req-1');
    expect(approved).toBe(true); // allow + updatedInput
    expect((updatedInput as { answers: Record<string, string> }).answers['Pick colors?']).toBe('Red, Blue');
    expect(askSelection.selected('req-1')).toEqual([]); // freed, no leak
    expect(store.peekAskContext('req-1')).toBeUndefined(); // consumed
  });

  it('asksubmit: for an unknown/expired requestId replies with the stale-card notice — not a silent no-op', async () => {
    const permAnswer = vi.fn();
    const askSelection = new AskSelection();
    askSelection.toggle('gone', 0); // stale selection with no matching context
    const msgs: Array<{ kind: string; text?: string }> = [];
    const h = new InboundHandler(baseDeps({
      imBy: () => makeAdapter(msgs),
      askSelection,
      permissionRouter: { answer: permAnswer, requestPermission: vi.fn() } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'asksubmit:gone' }));
    expect(permAnswer).not.toHaveBeenCalled();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/no longer active/i);
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

  it('allowtool:<rid>:<tool> grants the tool and approves the request', async () => {
    const addAllowTool = vi.fn();
    const permAnswer = vi.fn().mockReturnValue(true); // hit — a live pending
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

describe('quoting a live ASK card = free-form answer (the remote "Type something")', () => {
  it('single-select: quoted text becomes the ask answer via allow + updatedInput (not a bare deny reason)', async () => {
    const answers: Array<{ rid: string; approved: boolean; updatedInput?: unknown }> = [];
    const store = askStore('req-1', { question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] });
    const h = new InboundHandler(baseDeps({
      findLiveCard: () => 'req-1',
      ...store.deps,
      permissionRouter: {
        answer: (rid: string, approved: boolean, _m?: string, updatedInput?: unknown) => { answers.push({ rid, approved, updatedInput }); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    }));
    await h.handle(envelope({ text: 'a warm orange, actually', replyToMessageId: 'card-msg-1' }));
    expect(answers).toHaveLength(1);
    expect(answers[0].approved).toBe(true); // allow, not deny
    expect((answers[0].updatedInput as { answers: Record<string, string> }).answers['Pick a color?']).toBe('a warm orange, actually');
    expect(store.peekAskContext('req-1')).toBeUndefined(); // consumed, single-use
  });

  it('multi-select: ticked boxes ride along with the typed text', async () => {
    const answers: Array<{ updatedInput?: unknown }> = [];
    const store = askStore('req-1', { question: 'Channels?', options: [{ label: 'Feishu' }, { label: 'Telegram' }] });
    const deps = baseDeps({
      findLiveCard: () => 'req-1',
      ...store.deps,
      permissionRouter: {
        answer: (_r: string, _a: boolean, _m?: string, updatedInput?: unknown) => { answers.push({ updatedInput }); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    });
    deps.askSelection.toggle('req-1', 1); // Telegram ticked
    const h = new InboundHandler(deps);
    await h.handle(envelope({ text: 'and email please', replyToMessageId: 'card-msg-1' }));
    expect((answers[0].updatedInput as { answers: Record<string, string> }).answers['Channels?']).toBe('Telegram, and email please');
  });
});

function askStore(rid: string, ctx: { question: string; options: Array<{ label: string }> }) {
  const map = new Map([[rid, ctx]]);
  return {
    peekAskContext: (r: string) => map.get(r),
    deps: {
      peekAskContext: (r: string) => map.get(r),
      takeAskContext: (r: string) => { const v = map.get(r); map.delete(r); return v; },
    },
  };
}

describe('native input box submits (Feishu form → formText)', () => {
  it('askinput:<rid> + formText answers the ask with picks merged in', async () => {
    const answers: Array<{ updatedInput?: unknown }> = [];
    const store = askStore('req-1', { question: 'Channels?', options: [{ label: 'Feishu' }, { label: 'Telegram' }] });
    const deps = baseDeps({
      ...store.deps,
      permissionRouter: {
        answer: (_r: string, _a: boolean, _m?: string, updatedInput?: unknown) => { answers.push({ updatedInput }); return true; },
        requestPermission: vi.fn(),
      } as unknown as PermissionRouter,
    });
    deps.askSelection.toggle('req-1', 0);
    const h = new InboundHandler(deps);
    await h.handle(envelope({ text: 'askinput:req-1', formText: 'and email' }));
    expect((answers[0].updatedInput as { answers: Record<string, string> }).answers['Channels?']).toBe('Feishu, and email');
    expect(store.peekAskContext('req-1')).toBeUndefined(); // consumed
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
