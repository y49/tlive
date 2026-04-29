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
    partitionBindings(_: string) {
      return {
        primary: { channelType: 'feishu' as const, chatId: '100', role: 'primary' as const },
        mirrors: [],
        all: [{ channelType: 'feishu' as const, chatId: '100', role: 'primary' as const }],
      };
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

describe('integration: Feishu end-to-end with reaction fallback', () => {
  let ctx: ReturnType<typeof makeFrontend>;
  beforeEach(() => { ctx = makeFrontend(); });

  it('attach → file-edit permission with diff → allow (new UX path)', async () => {
    const session = new FakeSession({ id: 'sess-f', workspaceId: 'w1' });
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

    // New UX: PermissionCard renders 🔐 Permission: <code>Edit</code> (not 📝 Edit).
    const sends = ctx.adapter.byKind('send');
    expect(sends.some((s) => String(s.args.text ?? '').includes('Permission'))).toBe(true);
    expect(sends.some((s) => String(s.args.text ?? '').includes('Edit'))).toBe(true);
    // Tool input JSON preview included in the card.
    expect(sends.some((s) => String(s.args.text ?? '').includes('README.md'))).toBe(true);
    // Broker resolved event cleans up the card registry (no crash).
    expect(ctx.adapter.byKind('send').length).toBeGreaterThanOrEqual(1);
  });

  it('reactions are never invoked on Feishu (capability matrix enforces)', async () => {
    const session = new FakeSession({ id: 'sess-r', workspaceId: 'w1' });
    ctx.sm.push({ kind: 'created', session });
    await tick();
    session.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'x', at: 1_000_000 });
    await tick();
    expect(ctx.adapter.byKind('setReaction')).toHaveLength(0);
  });
});
