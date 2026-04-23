import { describe, it, expect } from 'vitest';
import { TodoStickyRenderer, renderTodoText } from '../../../src/im/render/todo-sticky.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { newSessionRenderState } from '../../../src/im/render/types.js';
import { FakeAdapter } from '../fake-adapter.js';

function makeState() {
  return newSessionRenderState({
    sessionId: 's1', shortAlias: 'abcd',
    workspaceId: 'w1', workspaceName: 'ws',
    targets: [{ channelType: 'telegram', chatId: '10', role: 'primary' }],
  });
}

describe('todo-sticky', () => {
  it('renders progress header + status glyphs', () => {
    const t = renderTodoText([
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'in_progress' },
      { content: 'three', status: 'pending' },
    ]);
    expect(t).toContain('📋 Todo (1/3)');
    expect(t).toContain('✅ one');
    expect(t).toContain('⏳ two');
    expect(t).toContain('⬜ three');
  });

  it('pin+edit path on pinning platform', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const r = new TodoStickyRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    await r.update([{ content: 'a', status: 'pending' }]);
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(adapter.byKind('pin')).toHaveLength(1);
    await r.update([{ content: 'a', status: 'completed' }]);
    expect(adapter.byKind('edit')).toHaveLength(1);
  });

  it('rebroadcast mode on Discord (no pin) with debounce', async () => {
    const adapter = new FakeAdapter('discord');
    const state = newSessionRenderState({
      sessionId: 's1', shortAlias: 'abcd',
      workspaceId: 'w1', workspaceName: 'ws',
      targets: [{ channelType: 'discord', chatId: '10', role: 'primary' }],
    });
    const target = state.targets[0]!;
    let now = 1_000_000;
    const timers = {
      setTimeout: ((fn: () => void, _delay: number) => setTimeout(fn, 0)) as unknown as typeof setTimeout,
      clearTimeout: clearTimeout as typeof clearTimeout,
    };
    const r = new TodoStickyRenderer({
      adapter, capabilities: CAPABILITIES.discord, session: state, target,
      clock: () => now, timers,
    });
    // First update renders immediately (no prior render).
    await r.update([{ content: 'a', status: 'pending' }]);
    expect(adapter.byKind('send')).toHaveLength(1);
    // 5 rapid updates within debounce window → coalesced to at most 1 more render.
    for (let i = 0; i < 5; i++) {
      now += 10;
      await r.update([{ content: 'a', status: i === 4 ? 'completed' : 'in_progress' }]);
    }
    // Wait for debounce timer to fire.
    await new Promise((res) => setTimeout(res, 30));
    // After the burst + debounce, we should have at most 2 send cycles total
    // (initial + one coalesced), not 6.
    expect(adapter.byKind('send').length).toBeLessThanOrEqual(2);
    expect(adapter.byKind('delete').length).toBeLessThanOrEqual(1);
  });
});
