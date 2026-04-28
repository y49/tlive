import { describe, it, expect } from 'vitest';
import { AgentMessageRenderer, AGENT_FLUSH_CHARS } from '../../../src/im/render/agent-message.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { newSessionRenderState, newTurnRenderState } from '../../../src/im/render/types.js';
import { FakeAdapter } from '../fake-adapter.js';

function setup() {
  const adapter = new FakeAdapter('telegram');
  const state = newSessionRenderState({
    sessionId: 's1', shortAlias: 'abcd',
    workspaceId: 'w1', workspaceName: 'app',
    targets: [{ channelType: 'telegram', chatId: '5', role: 'primary' }],
  });
  state.turn = newTurnRenderState('t1', 1_000_000, 0);
  let now = 1_000_000;
  const target = state.targets[0]!;
  const r = new AgentMessageRenderer({
    adapter, capabilities: CAPABILITIES.telegram, session: state, target,
    clock: () => now,
  });
  return { adapter, state, r };
}

describe('AgentMessageRenderer', () => {
  it('assistant_text flushes immediately', async () => {
    const { adapter, r } = setup();
    await r.onEvent({ kind: 'assistant_text', turnId: 't1', text: 'hello', complete: true });
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(adapter.byKind('send')[0]!.args.text).toBe('hello');
  });

  it('delta accumulates until 200-char threshold then flushes', async () => {
    const { adapter, r } = setup();
    // one large chunk > AGENT_FLUSH_CHARS
    const big = 'x'.repeat(AGENT_FLUSH_CHARS + 10);
    await r.onEvent({ kind: 'assistant_text_delta', turnId: 't1', text: big, partial: true });
    expect(adapter.byKind('send')).toHaveLength(1);
  });

  it('turn_end force-flushes accumulated text', async () => {
    const { adapter, r } = setup();
    await r.onEvent({ kind: 'assistant_text_delta', turnId: 't1', text: 'hi', partial: true });
    expect(adapter.byKind('send')).toHaveLength(0);
    await r.onEvent({ kind: 'turn_end', turnId: 't1', durationMs: 100, costUsd: 0, tokensIn: 0, tokensOut: 0 });
    expect(adapter.byKind('send')).toHaveLength(1);
  });

  it('splits very long text by maxTextLen', async () => {
    const { adapter, r } = setup();
    const huge = 'y'.repeat(CAPABILITIES.telegram.maxTextLen + 500);
    await r.onEvent({ kind: 'assistant_text', turnId: 't1', text: huge, complete: true });
    // first is send (primary chunk); remaining chunks each new send
    const sends = adapter.byKind('send');
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  // Regression — issue 2: two concurrent flushes must NOT both `send` a
  // primary message when `agentMsgId` starts undefined. Previous behavior:
  // both flushes saw `turn.agentMsgId === undefined` (the first hadn't yet
  // returned the new id), both called adapter.send → two distinct primary
  // messages were posted, producing duplicate Claude reply text in IM.
  // The fix is the inFlightFlush serialization chain in flush().
  it('serializes concurrent flushes — agentMsgId set once, only one primary send', async () => {
    const adapter = new FakeAdapter('telegram');
    // Wrap adapter.send so it stalls long enough that a second flush would
    // observe agentMsgId still undefined under the old (un-serialized) code.
    const realSend = adapter.send.bind(adapter);
    let resolveFirstSend: (() => void) | null = null;
    const firstSendBlocker = new Promise<void>((resolve) => { resolveFirstSend = resolve; });
    let sendCount = 0;
    adapter.send = async (msg) => {
      sendCount++;
      if (sendCount === 1) await firstSendBlocker;
      return realSend(msg);
    };

    const state = newSessionRenderState({
      sessionId: 's1', shortAlias: 'abcd',
      workspaceId: 'w1', workspaceName: 'app',
      targets: [{ channelType: 'telegram', chatId: '5', role: 'primary' }],
    });
    state.turn = newTurnRenderState('t1', 1_000_000, 0);
    const target = state.targets[0]!;
    const r = new AgentMessageRenderer({
      adapter, capabilities: CAPABILITIES.telegram, session: state, target,
      clock: () => 1_000_000,
    });

    // Trigger flush A: streaming delta crosses threshold → kicks flush().
    // We don't await because the first send is blocked on the gate.
    state.turn!.agentAccText = 'a'.repeat(AGENT_FLUSH_CHARS + 10);
    state.turn!.hasAssistantText = true;
    const pA = r.flush();
    // Trigger flush B WHILE A is mid-await. Without the serialization fix,
    // B would observe agentMsgId still undefined → call adapter.send a 2nd time.
    state.turn!.agentAccText = 'a'.repeat(AGENT_FLUSH_CHARS + 50);
    const pB = r.flush();
    // Release flush A's send.
    resolveFirstSend!();
    await Promise.all([pA, pB]);

    // Exactly one primary send (no duplicate). agentMsgId is set.
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(state.turn!.agentMsgId).toBeDefined();
  });

  it('subsequent flush after agentMsgId set uses edit, never re-sends', async () => {
    const { adapter, state, r } = setup();
    await r.onEvent({ kind: 'assistant_text', turnId: 't1', text: 'first', complete: true });
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(state.turn!.agentMsgId).toBeDefined();

    // Simulate an additional flush triggered by a delayed timer firing after
    // the complete event has already locked in the rendered text. New text
    // arrives → flush via assistant_text replaces accText → edit, not send.
    await r.onEvent({ kind: 'assistant_text', turnId: 't1', text: 'first updated', complete: true });
    expect(adapter.byKind('send')).toHaveLength(1); // still just one
    expect(adapter.byKind('edit')).toHaveLength(1);
  });
});
