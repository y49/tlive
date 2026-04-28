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
});
