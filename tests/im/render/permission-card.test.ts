import { describe, it, expect } from 'vitest';
import { PermissionCardRenderer, renderPermissionCard, permissionButtons } from '../../../src/im/render/permission-card.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { newSessionRenderState } from '../../../src/im/render/types.js';
import { FakeAdapter } from '../fake-adapter.js';
import type { PermissionRequest } from '../../../src/runtime/types.js';

function makeReq(cat: PermissionRequest['category'], extras: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'sess:p1',
    category: cat,
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    resolve: () => { /* noop */ },
    ...extras,
  };
}

function makeState() {
  return newSessionRenderState({
    sessionId: 's1', shortAlias: 'abcd',
    workspaceId: 'w1', workspaceName: 'ws',
    targets: [{ channelType: 'telegram', chatId: '10', role: 'primary' }],
  });
}

describe('permission-card', () => {
  it('exec template includes command in bash fence', () => {
    const t = renderPermissionCard(makeReq('exec', { toolInput: { command: 'rm -rf /', description: 'delete' }, risk: 'high' }));
    expect(t).toContain('🔒 Permission');
    expect(t).toContain('```bash');
    expect(t).toContain('rm -rf /');
    expect(t).toContain('🚨 high-risk');
  });

  it('file-edit template includes diff + stats', () => {
    const t = renderPermissionCard(makeReq('file-edit', {
      toolName: 'Edit',
      toolInput: { file_path: 'src/a.ts' },
      diffPreview: { from: 'old', to: 'new', added: 1, removed: 1, path: 'src/a.ts' },
    }));
    expect(t).toContain('📝 Edit');
    expect(t).toContain('src/a.ts');
    expect(t).toContain('+1 -1');
    expect(t).toContain('```diff');
  });

  it('generic template JSON-formats toolInput', () => {
    const t = renderPermissionCard(makeReq('generic', { toolName: 'X', toolInput: { foo: 1 } }));
    expect(t).toContain('🧩 X');
    expect(t).toContain('"foo": 1');
  });

  it('elicitation template is a minimal placeholder (real render is ElicitationForm)', () => {
    const t = renderPermissionCard(makeReq('elicitation'));
    expect(t).toContain('🔒 Elicitation');
  });

  it('buttons include Allow/Deny/Always/Learn', () => {
    const m = permissionButtons('r1');
    const flat = (m.buttons ?? []).flat().map((b) => b.text);
    expect(flat).toContain('✅ Allow');
    expect(flat).toContain('❌ Deny');
    expect(flat).toContain('🔁 Always');
    expect(flat).toContain('💡 Learn');
  });

  it('renderer sends card on pending, edits on resolve', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const r = new PermissionCardRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    const req = makeReq('generic');
    await r.onPending(req);
    expect(adapter.byKind('send')).toHaveLength(1);
    await r.onResolved(req.id, 'allow');
    expect(adapter.byKind('edit')).toHaveLength(1);
    expect(String(adapter.byKind('edit')[0]!.args.text)).toContain('Allowed');
  });

  it('skips elicitation category (routed elsewhere)', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = makeState();
    const target = state.targets[0]!;
    const r = new PermissionCardRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    await r.onPending(makeReq('elicitation'));
    expect(adapter.calls).toHaveLength(0);
  });

  it('mirror target omits inline buttons and appends "Respond from primary" tail', async () => {
    const adapter = new FakeAdapter('telegram');
    const state = newSessionRenderState({
      sessionId: 's1', shortAlias: 'abcd',
      workspaceId: 'w1', workspaceName: 'ws',
      targets: [{ channelType: 'telegram', chatId: '20', role: 'mirror' }],
    });
    const target = state.targets[0]!;
    const r = new PermissionCardRenderer({ adapter, capabilities: CAPABILITIES.telegram, session: state, target });
    await r.onPending(makeReq('generic'));
    const send = adapter.byKind('send')[0]!;
    expect(send.args.replyMarkup).toBeUndefined();
    expect(String(send.args.text)).toContain('Respond from primary chat');
  });
});
