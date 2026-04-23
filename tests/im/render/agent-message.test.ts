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
});
