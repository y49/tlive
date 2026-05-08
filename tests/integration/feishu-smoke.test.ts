import { describe, it, expect, beforeEach } from 'vitest';
import { SessionFrontend } from '../../src/im/frontend.js';
import type { PermissionBroker, BrokerListener } from '../../src/permission/broker.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import { FakeAdapter } from '../im/fake-adapter.js';
import { FakeSession, mkFakeSessionManager } from '../im/fake-session.js';

function makeFrontend() {
  const adapter = new FakeAdapter('feishu');
  const sm = mkFakeSessionManager();
  const pbListeners = new Set<BrokerListener>();
  const pb = {
    subscribe(l: BrokerListener) { pbListeners.add(l); return () => pbListeners.delete(l); },
    push(ev: Parameters<BrokerListener>[0]) { for (const l of pbListeners) l(ev); },
  } as unknown as PermissionBroker & { push: (ev: Parameters<BrokerListener>[0]) => void };
  const wm = {
    listBindings(_: string) {
      return [{ channelType: 'feishu' as const, chatId: '100', activeSessionId: null }];
    },
    get(_: string) { return { name: 'ws', defaults: { model: 'claude' } }; },
  } as unknown as WorkspaceManager;
  const frontend = new SessionFrontend({
    sessionManager: sm,
    workspaceManager: wm,
    permissionBroker: pb,
    adapters: { feishu: adapter },
  });
  frontend.start();
  return { frontend, adapter, sm, pb };
}

async function tick(ms = 10) { await new Promise((r) => setTimeout(r, ms)); }

describe('integration: Feishu end-to-end', () => {
  let ctx: ReturnType<typeof makeFrontend>;
  beforeEach(() => { ctx = makeFrontend(); });

  it('attach → file-edit permission with diff → allow (new UX path)', async () => {
    const session = new FakeSession({
      id: 'sess-f',
      workspaceId: 'w1',
      ownerChat: { channelType: 'feishu', chatId: '100' },
    });
    ctx.sm.push({ kind: 'created', session });
    await tick();

    ctx.pb.push({
      kind: 'pending',
      sessionId: 'sess-f',
      request: {
        id: 'sess-f:p1', category: 'file-edit',
        toolName: 'Edit', toolInput: { file_path: 'README.md' },
        diffPreview: { from: 'old', to: 'new', added: 1, removed: 1, path: 'README.md' },
        resolve: () => { /* noop */ },
      },
    });
    await tick();
    ctx.pb.push({
      kind: 'resolved',
      sessionId: 'sess-f', requestId: 'sess-f:p1', decision: 'allow_always',
    });
    await tick();

    // New UX: PermissionCard renders ✏ Edit — <path> for file-edit category (not raw JSON).
    const sends = ctx.adapter.byKind('send');
    expect(sends.some((s) => String(s.args.text ?? '').includes('✏'))).toBe(true);
    expect(sends.some((s) => String(s.args.text ?? '').includes('Edit'))).toBe(true);
    // File path shown in the card (not buried in JSON).
    expect(sends.some((s) => String(s.args.text ?? '').includes('README.md'))).toBe(true);
    // Broker resolved event cleans up the card registry (no crash).
    expect(ctx.adapter.byKind('send').length).toBeGreaterThanOrEqual(1);
  });

  it('native setReaction is invoked on Feishu (capability matrix enables)', async () => {
    const session = new FakeSession({
      id: 'sess-r',
      workspaceId: 'w1',
      ownerChat: { channelType: 'feishu', chatId: '100' },
    });
    ctx.sm.push({ kind: 'created', session });
    await tick();
    // Simulate an inbound message first so the tracker has a messageId to react to.
    ctx.frontend.markInboundReceived('feishu', '100', 'm1');
    await tick();
    session.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'x', at: 1_000_000 });
    await tick();
    // setReaction should now be called (native path).
    expect(ctx.adapter.byKind('setReaction').length).toBeGreaterThanOrEqual(1);
  });
});
