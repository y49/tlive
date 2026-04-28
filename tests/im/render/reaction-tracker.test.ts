import { describe, it, expect } from 'vitest';
import { ReactionTracker } from '../../../src/im/render/reaction-tracker.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { newSessionRenderState } from '../../../src/im/render/types.js';
import { FakeAdapter } from '../fake-adapter.js';

function makeState() {
  return newSessionRenderState({
    sessionId: 's1', shortAlias: 'abcd',
    workspaceId: 'w1', workspaceName: 'ws',
    targets: [{ channelType: 'telegram', chatId: '100', role: 'primary' }],
  });
}

describe('ReactionTracker', () => {
  it('uses native reaction on Telegram', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const tr = new ReactionTracker({
      adapter, capabilities: CAPABILITIES.telegram, session: state, target,
    });
    await tr.setPhase({ chatId: '100', messageId: 'm42' }, 'received');
    expect(adapter.byKind('setReaction')).toHaveLength(1);
    expect(adapter.byKind('setReaction')[0]!.args.emoji).toBe('👀');
  });

  it('falls back to reply-message on Feishu', async () => {
    const adapter = new FakeAdapter('feishu');
    const state = makeState();
    const target = state.targets[0]!;
    const tr = new ReactionTracker({
      adapter, capabilities: CAPABILITIES.feishu, session: state, target,
    });
    await tr.setPhase({ chatId: '100', messageId: 'f1' }, 'received');
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(adapter.byKind('send')[0]!.args.text).toBe('👀');
    expect(adapter.byKind('send')[0]!.args.replyToMessageId).toBe('f1');
  });

  it('edits existing fallback message on subsequent phase', async () => {
    const adapter = new FakeAdapter('feishu');
    const state = makeState();
    const target = state.targets[0]!;
    const tr = new ReactionTracker({
      adapter, capabilities: CAPABILITIES.feishu, session: state, target,
    });
    await tr.setPhase({ chatId: '100', messageId: 'f1' }, 'received');
    await tr.setPhase({ chatId: '100', messageId: 'f1' }, 'processing');
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(adapter.byKind('edit')).toHaveLength(1);
    expect(adapter.byKind('edit')[0]!.args.text).toBe('🤔');
  });

  it('done_ok renders 👌 (OK style, not 🎉)', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const tr = new ReactionTracker({
      adapter, capabilities: CAPABILITIES.telegram, session: state, target,
    });
    await tr.setPhase({ chatId: '100', messageId: 'm1' }, 'done_ok');
    const calls = adapter.byKind('setReaction');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.emoji).toBe('👌');
  });

  // Regression — issue 1: a slow in-flight `processing` setReaction must NOT
  // overwrite a later `done_ok` on the same inbound. The fix: per-inbound
  // chain + phase-precedence guard in ReactionTracker. SessionFrontend
  // dispatches turn_start (processing) and turn_end (done_ok) ~hundreds of
  // ms apart, but the underlying Telegram setReaction calls are async with
  // variable network latency. Without serialization, processing could land
  // AFTER done_ok and the user-visible reaction would stay stuck on 🤔.
  it('phase-precedence: stale processing dropped after done_ok requested', async () => {
    const adapter = new FakeAdapter('telegram');
    // Make adapter.setReaction stall so we can observe the race window.
    const realSet = adapter.setReaction.bind(adapter);
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let i = 0;
    adapter.setReaction = async (mid, cid, emoji) => {
      const call = ++i;
      if (call === 1) await gate;
      return realSet(mid, cid, emoji);
    };
    const state = makeState();
    const target = state.targets[0]!;
    const tr = new ReactionTracker({
      adapter, capabilities: CAPABILITIES.telegram, session: state, target,
    });

    // Caller order: processing → done_ok. Submit both before releasing the
    // first call's gate so they're in-flight simultaneously under the old
    // (unserialized) code.
    const p1 = tr.setPhase({ chatId: '100', messageId: 'mX' }, 'processing');
    const p2 = tr.setPhase({ chatId: '100', messageId: 'mX' }, 'done_ok');
    releaseFirst!();
    await Promise.all([p1, p2]);

    // Both calls were issued, but the LAST emoji written must be 👌
    // (done_ok), regardless of which underlying network call resolved first.
    const calls = adapter.byKind('setReaction');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1]!.args.emoji).toBe('👌');
  });

  it('phase-precedence: late-arriving received drops after processing', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const tr = new ReactionTracker({
      adapter, capabilities: CAPABILITIES.telegram, session: state, target,
    });
    await tr.setPhase({ chatId: '100', messageId: 'mY' }, 'processing');
    await tr.setPhase({ chatId: '100', messageId: 'mY' }, 'received');
    // received (rank 1) < processing (rank 2) → the received call is a no-op.
    const calls = adapter.byKind('setReaction');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.emoji).toBe('🤔');
  });

  it('different inbound messageIds have independent chains', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const tr = new ReactionTracker({
      adapter, capabilities: CAPABILITIES.telegram, session: state, target,
    });
    // Two different inbounds — each phase chain independent.
    await tr.setPhase({ chatId: '100', messageId: 'mA' }, 'done_ok');
    await tr.setPhase({ chatId: '100', messageId: 'mB' }, 'received');
    const calls = adapter.byKind('setReaction');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args.messageId)).toEqual(['mA', 'mB']);
    expect(calls.map((c) => c.args.emoji)).toEqual(['👌', '👀']);
  });
});
