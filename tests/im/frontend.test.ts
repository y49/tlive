import { describe, it, expect, beforeEach } from 'vitest';
import { SessionFrontend } from '../../src/im/frontend.js';
import type { SessionManager, ManagerEventListener } from '../../src/session/manager.js';
import type { PermissionBroker, BrokerListener } from '../../src/permission/broker.js';
import type { AskUserQuestionBroker, AskBrokerListener } from '../../src/permission/ask-broker.js';
import type { ElicitationBroker, ElicitationBrokerListener } from '../../src/permission/elicitation-broker.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import { FakeAdapter } from './fake-adapter.js';
import { FakeSession } from './fake-session.js';

function mkFakeSessionManager(): SessionManager & { push: ManagerEventListener } {
  const listeners = new Set<ManagerEventListener>();
  return {
    subscribe(l: ManagerEventListener) { listeners.add(l); return () => listeners.delete(l); },
    push(ev) { for (const l of listeners) l(ev); },
  } as unknown as SessionManager & { push: ManagerEventListener };
}

function mkFakeBroker(): PermissionBroker & { push: BrokerListener } {
  const listeners = new Set<BrokerListener>();
  return {
    subscribe(l: BrokerListener) { listeners.add(l); return () => listeners.delete(l); },
    push(ev: Parameters<BrokerListener>[0]) { for (const l of listeners) l(ev); },
  } as unknown as PermissionBroker & { push: BrokerListener };
}

function mkFakeAskBroker(): AskUserQuestionBroker & { push: AskBrokerListener } {
  const listeners = new Set<AskBrokerListener>();
  return {
    subscribe(l: AskBrokerListener) { listeners.add(l); return () => listeners.delete(l); },
    push(ev: Parameters<AskBrokerListener>[0]) { for (const l of listeners) l(ev); },
  } as unknown as AskUserQuestionBroker & { push: AskBrokerListener };
}

function mkFakeElicBroker(): ElicitationBroker & { push: ElicitationBrokerListener } {
  const listeners = new Set<ElicitationBrokerListener>();
  return {
    subscribe(l: ElicitationBrokerListener) { listeners.add(l); return () => listeners.delete(l); },
    push(ev: Parameters<ElicitationBrokerListener>[0]) { for (const l of listeners) l(ev); },
  } as unknown as ElicitationBroker & { push: ElicitationBrokerListener };
}

function mkFakeWm(): WorkspaceManager {
  return {
    partitionBindings(_: string) {
      return {
        primary: { channelType: 'telegram', chatId: '100', role: 'primary' },
        mirrors: [],
        all: [{ channelType: 'telegram', chatId: '100', role: 'primary' }],
      };
    },
    get(_: string) {
      return { name: 'ws', defaults: { model: 'claude-sonnet-4' } };
    },
  } as unknown as WorkspaceManager;
}

describe('SessionFrontend', () => {
  let adapter: FakeAdapter;
  let sm: ReturnType<typeof mkFakeSessionManager>;
  let pb: ReturnType<typeof mkFakeBroker>;
  let ab: ReturnType<typeof mkFakeAskBroker>;
  let eb: ReturnType<typeof mkFakeElicBroker>;
  let frontend: SessionFrontend;

  beforeEach(() => {
    adapter = new FakeAdapter('telegram');
    sm = mkFakeSessionManager();
    pb = mkFakeBroker();
    ab = mkFakeAskBroker();
    eb = mkFakeElicBroker();
    frontend = new SessionFrontend({
      sessionManager: sm,
      workspaceManager: mkFakeWm(),
      permissionBroker: pb,
      askBroker: ab,
      elicitationBroker: eb,
      adapters: { telegram: adapter },
    });
    frontend.start();
  });

  it('attaches renderers on session created and sends header', async () => {
    const session = new FakeSession({ id: 'sess-1', workspaceId: 'w1' });
    sm.push({ kind: 'created', session } as Parameters<typeof sm.push>[0]);
    // Allow microtasks to flush
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.byKind('send').length).toBeGreaterThanOrEqual(1);
  });

  it('routes turn_start to activity sticky', async () => {
    const session = new FakeSession({ id: 'sess-2', workspaceId: 'w1' });
    sm.push({ kind: 'created', session } as Parameters<typeof sm.push>[0]);
    await new Promise((r) => setTimeout(r, 10));
    session.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 1_000_000 });
    await new Promise((r) => setTimeout(r, 10));
    // At least the header + activity sticky
    expect(adapter.byKind('send').length).toBeGreaterThanOrEqual(2);
  });

  it('routes permission_requested via PermissionBroker', async () => {
    const session = new FakeSession({ id: 'sess-3', workspaceId: 'w1' });
    sm.push({ kind: 'created', session } as Parameters<typeof sm.push>[0]);
    await new Promise((r) => setTimeout(r, 10));
    const countBefore = adapter.byKind('send').length;
    pb.push({
      kind: 'pending',
      sessionId: 'sess-3',
      request: {
        id: 'sess-3:p1', category: 'generic', toolName: 'X', toolInput: {},
        resolve: () => { /* noop */ },
      },
    } as Parameters<typeof pb.push>[0]);
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.byKind('send').length).toBeGreaterThan(countBefore);
  });

  it('routes todo_write to todo sticky', async () => {
    const session = new FakeSession({ id: 'sess-4', workspaceId: 'w1' });
    sm.push({ kind: 'created', session } as Parameters<typeof sm.push>[0]);
    await new Promise((r) => setTimeout(r, 10));
    session.emit({ kind: 'todo_write', items: [{ content: 'a', status: 'pending' }] });
    await new Promise((r) => setTimeout(r, 10));
    const sends = adapter.byKind('send').map((c) => String(c.args.text));
    expect(sends.some((t) => t.includes('📋 Todo'))).toBe(true);
  });

  it('tears down on session stopped', async () => {
    const session = new FakeSession({ id: 'sess-5', workspaceId: 'w1' });
    sm.push({ kind: 'created', session } as Parameters<typeof sm.push>[0]);
    await new Promise((r) => setTimeout(r, 10));
    sm.push({ kind: 'stopped', sessionId: 'sess-5' } as Parameters<typeof sm.push>[0]);
    await new Promise((r) => setTimeout(r, 10));
    expect(frontend.getChannelsForTest('sess-5')).toBeUndefined();
  });

  it('routes elicitation_requested via ElicitationBroker', async () => {
    const session = new FakeSession({ id: 'sess-6', workspaceId: 'w1' });
    sm.push({ kind: 'created', session } as Parameters<typeof sm.push>[0]);
    await new Promise((r) => setTimeout(r, 10));
    const countBefore = adapter.byKind('send').length;
    eb.push({
      kind: 'pending',
      sessionId: 'sess-6',
      request: {
        id: 'e1', mcpServerName: 'git', mode: 'confirm',
        resolve: () => { /* noop */ },
      },
    } as Parameters<typeof eb.push>[0]);
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.byKind('send').length).toBeGreaterThan(countBefore);
  });
});
