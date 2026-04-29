import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// ---------------------------------------------------------------------------
// TL_NEW_UX path tests
// ---------------------------------------------------------------------------

function mkFakeSessionManagerWithGet(sessions: Map<string, FakeSession>): SessionManager & { push: ManagerEventListener } {
  const listeners = new Set<ManagerEventListener>();
  return {
    subscribe(l: ManagerEventListener) { listeners.add(l); return () => listeners.delete(l); },
    push(ev: Parameters<ManagerEventListener>[0]) { for (const l of listeners) l(ev); },
    get(id: string) { return sessions.get(id); },
  } as unknown as SessionManager & { push: ManagerEventListener };
}

async function bootstrapFrontend(): Promise<{
  frontend: SessionFrontend;
  adapter: FakeAdapter;
  fakeSession: FakeSession;
  sessionManager: ReturnType<typeof mkFakeSessionManagerWithGet>;
}> {
  const adapter = new FakeAdapter('telegram');
  const fakeSession = new FakeSession({ id: 'ux-sess-1', workspaceId: 'ux-ws-1' });
  const sessions = new Map([[fakeSession.id, fakeSession]]);
  const sessionManager = mkFakeSessionManagerWithGet(sessions);
  const permissionBroker = mkFakeBroker();
  const askBroker = mkFakeAskBroker();
  const elicitationBroker = mkFakeElicBroker();
  const workspaceManager = mkFakeWm();
  const frontend = new SessionFrontend({
    sessionManager,
    workspaceManager,
    permissionBroker,
    askBroker,
    elicitationBroker,
    adapters: { telegram: adapter },
  });
  frontend.start();
  // Attach session via the SessionManager 'created' event
  sessionManager.push({ kind: 'created', session: fakeSession } as Parameters<typeof sessionManager.push>[0]);
  await flushAsync();
  return { frontend, adapter, fakeSession, sessionManager };
}

async function flushAsync(): Promise<void> {
  // Drain microtasks first.
  await Promise.resolve();
  // Then advance fake timers past TurnUI's 250ms debounce.
  await vi.advanceTimersByTimeAsync(300);
}

describe('SessionFrontend — TL_NEW_UX path', () => {
  const orig = process.env.TL_NEW_UX;
  beforeEach(() => {
    process.env.TL_NEW_UX = '1';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (orig === undefined) delete process.env.TL_NEW_UX;
    else process.env.TL_NEW_UX = orig;
  });

  it('on turn_start creates a TurnUI and sends a HUD via adapter', async () => {
    const { adapter, fakeSession } = await bootstrapFrontend();
    const sendsBefore = adapter.calls.filter(c => c.kind === 'send').length;
    fakeSession.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 0 });
    await flushAsync();
    // TurnUI.start() sends the HUD — filter sends that happened after bootstrap
    const newSends = adapter.calls.filter(c => c.kind === 'send').slice(sendsBefore);
    expect(newSends.length).toBeGreaterThanOrEqual(1);
    // HUD text is formatted as a <pre><code> block by formatTelegramHud
    expect((newSends[0].args.text as string)).toMatch(/^<pre><code>/);
  });

  it('a second turn_start destroys the previous TurnUI before creating a new one', async () => {
    const { adapter, fakeSession } = await bootstrapFrontend();
    const sendsBefore = adapter.calls.filter(c => c.kind === 'send').length;
    fakeSession.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'a', at: 0 });
    await flushAsync();
    fakeSession.emit({ kind: 'turn_start', turnId: 't2', userInputPreview: 'b', at: 100 });
    await flushAsync();
    // Each turn_start sends one new HUD message → exactly 2 HUD sends after bootstrap
    expect(adapter.calls.filter(c => c.kind === 'send').length - sendsBefore).toBe(2);
  });

  it('session stopped destroys the active TurnUI (no edits on late events)', async () => {
    const { adapter, fakeSession, sessionManager } = await bootstrapFrontend();
    fakeSession.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: 'a', at: 0 });
    await flushAsync();
    sessionManager.push({ kind: 'stopped', sessionId: fakeSession.id } as Parameters<typeof sessionManager.push>[0]);
    await flushAsync();
    // Capture edit count AFTER session stop and all pending timers drained
    const editCountAfterStop = adapter.calls.filter(c => c.kind === 'edit').length;
    fakeSession.emit({ kind: 'tool_use_start', turnId: 't1', toolUseId: 'u', toolName: 'Bash', input: {} });
    await flushAsync();
    // No additional edits should occur after the session was stopped
    expect(adapter.calls.filter(c => c.kind === 'edit').length).toBe(editCountAfterStop);
  });
});
