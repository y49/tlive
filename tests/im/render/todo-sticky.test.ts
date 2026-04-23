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
    const r = new TodoStickyRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state });
    await r.update([{ content: 'a', status: 'pending' }]);
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(adapter.byKind('pin')).toHaveLength(1);
    await r.update([{ content: 'a', status: 'completed' }]);
    expect(adapter.byKind('edit')).toHaveLength(1);
  });

  it('rebroadcast mode on Discord (no pin)', async () => {
    const adapter = new FakeAdapter('discord');
    const state = makeState();
    const r = new TodoStickyRenderer({ adapter, capabilities: CAPABILITIES.discord, session: state });
    await r.update([{ content: 'a', status: 'pending' }]);
    await r.update([{ content: 'a', status: 'completed' }]);
    expect(adapter.byKind('delete')).toHaveLength(1);
    expect(adapter.byKind('send')).toHaveLength(2);
  });
});
