import { describe, it, expect } from 'vitest';
import { AgentMessageRenderer, AGENT_FLUSH_CHARS, buildAgentFooter } from '../../../src/im/render/agent-message.js';
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

  // Issue: agent-message must request HTML parse mode so Telegram renders
  // **bold**, code fences, etc. Without parseMode='html' the user sees raw
  // markdown source.
  it("primary target sends with parseMode='html'", async () => {
    const { adapter, r } = setup();
    await r.onEvent({ kind: 'assistant_text', turnId: 't1', text: 'use `ls`', complete: true });
    const send = adapter.byKind('send')[0]!;
    expect(send.args.parseMode).toBe('html');
  });

  // Issue: footer must be appended ONLY when there's body text. Empty turns
  // (agent ran tools but said nothing) shouldn't yield a footer-only message.
  it('appends footer on turn_end when body text exists', async () => {
    const { adapter, state, r } = setup();
    state.turn!.toolUseCounts.set('Bash', 2);
    state.turn!.toolUseCounts.set('Read', 1);
    state.costUsd = 0.12;
    await r.onEvent({ kind: 'assistant_text_delta', turnId: 't1', text: 'Hello.', partial: true });
    await r.onEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 32_000, costUsd: 0.09,
      tokensIn: 7, tokensOut: 528,
    });
    const sends = adapter.byKind('send');
    expect(sends).toHaveLength(1);
    const text = String(sends[0]!.args.text);
    expect(text).toContain('Hello.');
    expect(text).toContain('📦');
    expect(text).toContain('Bash ×2');
    expect(text).toContain('Read ×1');
    expect(text).toContain('(3 total)');
    expect(text).toContain('📊');
    expect(text).toContain('7/528 tok');
    expect(text).toContain('$0.09');
    expect(text).toContain('Σ $0.12');
    expect(text).toContain('32.0s');
  });

  it('does NOT emit a message on empty turn_end (no body text)', async () => {
    const { adapter, state, r } = setup();
    state.turn!.toolUseCounts.set('Bash', 1);
    await r.onEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 100, costUsd: 0.01,
      tokensIn: 0, tokensOut: 0,
    });
    expect(adapter.calls).toHaveLength(0);
  });

  // Helper export sanity-check.
  it('buildAgentFooter returns null when no tools and no stats', () => {
    const turn = newTurnRenderState('t', 0, 0);
    expect(buildAgentFooter(turn, 0)).toBeNull();
  });

  // Fix 2: edit-fail for agent message must delete old message before sending
  // a new one, preventing duplicate assistant text visible in chat.
  it('edit-fail on agent message: deletes old id then sends new one', async () => {
    const { adapter, state, r } = setup();
    // First flush via assistant_text — creates the primary message.
    await r.onEvent({ kind: 'assistant_text', turnId: 't1', text: 'Hello.', complete: true });
    expect(adapter.byKind('send')).toHaveLength(1);
    const oldMsgId = state.turn!.agentMsgId!;
    expect(oldMsgId).toBeDefined();

    // Make edits throw.
    adapter.edit = async () => { throw new Error('message can\'t be edited'); };

    // turn_end triggers another flush (body + footer).
    state.turn!.toolUseCounts.set('Bash', 1);
    await r.onEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 1000, costUsd: 0.01, tokensIn: 5, tokensOut: 10,
    });

    // Old message deleted before new send.
    const deletes = adapter.byKind('delete');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(deletes[0]!.args.messageId).toBe(oldMsgId);

    // Exactly one additional send (not two).
    expect(adapter.byKind('send')).toHaveLength(2);
    // agentMsgId updated to the new message.
    expect(state.turn!.agentMsgId).not.toBe(oldMsgId);
  });

  // Fix 3: Two flushes per turn (body flush + footer flush via edit) is by
  // design for the streaming path. Verify the second flush uses edit (not send)
  // when agentMsgId is set, keeping exactly one primary message in chat.
  it('two-flush turn: body send then footer edit — only 1 primary message', async () => {
    const { adapter, state, r } = setup();
    state.turn!.toolUseCounts.set('Read', 1);
    // First flush: body text only (footer not yet available).
    await r.onEvent({ kind: 'assistant_text', turnId: 't1', text: 'The answer.', complete: true });
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(adapter.byKind('edit')).toHaveLength(0);
    // Second flush: turn_end adds footer → edit, NOT send.
    await r.onEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 2000, costUsd: 0.02, tokensIn: 10, tokensOut: 50,
    });
    expect(adapter.byKind('send')).toHaveLength(1); // still only 1 send
    expect(adapter.byKind('edit')).toHaveLength(1); // footer added via edit
  });

  it('buildAgentFooter renders single-tool single-stat footer', () => {
    const turn = newTurnRenderState('t', 0, 0);
    turn.toolUseCounts.set('Bash', 1);
    turn.lastTurnStats = { durationMs: 1500, costUsd: 0.05, tokensIn: 10, tokensOut: 20 };
    const footer = buildAgentFooter(turn, 0.1);
    expect(footer).toContain('Bash ×1');
    expect(footer).toContain('1 total');
    expect(footer).toContain('10/20 tok');
    expect(footer).toContain('$0.05');
    expect(footer).toContain('Σ $0.10');
    expect(footer).toContain('1.5s');
  });
});
