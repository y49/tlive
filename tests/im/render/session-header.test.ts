import { describe, it, expect } from 'vitest';
import { SessionHeaderRenderer, renderSessionHeaderText } from '../../../src/im/render/session-header.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { newSessionRenderState } from '../../../src/im/render/types.js';
import { FakeAdapter } from '../fake-adapter.js';

function makeState() {
  const s = newSessionRenderState({
    sessionId: 's1', shortAlias: 'abcd',
    workspaceId: 'w1', workspaceName: 'app',
    targets: [{ channelType: 'telegram', chatId: '10', role: 'primary' }],
  });
  s.model = 'claude-sonnet-4';
  s.costUsd = 0.12;
  return s;
}

describe('SessionHeaderRenderer', () => {
  it('renders text with workspace, model, cost', () => {
    const t = renderSessionHeaderText({
      workspaceName: 'app', shortAlias: 'abcd', model: 'claude', costUsd: 0.42,
    });
    expect(t).toContain('📁 app');
    expect(t).toContain('🧬 abcd');
    expect(t).toContain('🤖 claude');
    expect(t).toContain('💰 $0.42');
  });

  it('initialize sends + pins on a pinning platform', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const r = new SessionHeaderRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    await r.initialize();
    expect(adapter.byKind('send')).toHaveLength(1);
    expect(adapter.byKind('pin')).toHaveLength(1);
  });

  it('refresh edits the existing message when text changes', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const r = new SessionHeaderRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    await r.initialize();
    state.costUsd = 0.99;
    await r.refresh();
    expect(adapter.byKind('edit')).toHaveLength(1);
  });

  it('refresh skips when text unchanged', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const r = new SessionHeaderRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    await r.initialize();
    await r.refresh();
    expect(adapter.byKind('edit')).toHaveLength(0);
  });
});
