import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionFrontend } from '../../src/im/frontend.js';
import type { PermissionBroker, BrokerListener } from '../../src/permission/broker.js';
import type { AskUserQuestionBroker, AskBrokerListener } from '../../src/permission/ask-broker.js';
import type { ElicitationBroker, ElicitationBrokerListener } from '../../src/permission/elicitation-broker.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import { FakeAdapter } from './fake-adapter.js';
import { FakeSession, mkFakeSessionManager } from './fake-session.js';

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

async function bootstrapFrontend(): Promise<{
  frontend: SessionFrontend;
  adapter: FakeAdapter;
  fakeSession: FakeSession;
  sessionManager: ReturnType<typeof mkFakeSessionManager>;
  permissionBroker: ReturnType<typeof mkFakeBroker>;
}> {
  const adapter = new FakeAdapter('telegram');
  const fakeSession = new FakeSession({ id: 'ux-sess-1', workspaceId: 'ux-ws-1' });
  const sessions = new Map([[fakeSession.id, fakeSession]]);
  const sessionManager = mkFakeSessionManager({ sessions });
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
  return { frontend, adapter, fakeSession, sessionManager, permissionBroker };
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

  it('forwards assistant_text to ReplyRenderer (one reply send per primary)', async () => {
    const { adapter, fakeSession } = await bootstrapFrontend();
    fakeSession.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 0 });
    // Flush turn_start so replyRenderers are initialised before assistant_text arrives.
    await flushAsync();
    fakeSession.emit({ kind: 'assistant_text', turnId: 't1', text: 'hello world', complete: true });
    await flushAsync();
    // 1 HUD send + 1 reply send; reply contains 'hello world'.
    const sends = adapter.calls.filter(c => c.kind === 'send');
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends.some(s => /hello world/.test((s.args.text as string) ?? ''))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T6b: AskUserQuestion → PermissionCard (new UX path)
  // ---------------------------------------------------------------------------

  it('AskBroker pending → renders PermissionCard via send (new path)', async () => {
    const { adapter, fakeSession } = await bootstrapFrontend();
    const ab = mkFakeAskBroker();
    // Re-bootstrap with the ask broker exposed. We push directly via the
    // already-registered broker because bootstrapFrontend() wires it internally.
    // Instead, emit the event to the broker that was passed to the frontend.
    // NOTE: bootstrapFrontend does not expose the askBroker handle — however the
    // frontend subscribes to the one passed in; we need to use that one.
    // Simplest: bootstrap a fresh frontend with the broker we control.
    const adapter2 = new FakeAdapter('telegram');
    const fakeSession2 = new FakeSession({ id: 'ask-sess-1', workspaceId: 'ux-ws-1' });
    const sessions2 = new Map([[fakeSession2.id, fakeSession2]]);
    const sessionManager2 = mkFakeSessionManager({ sessions: sessions2 });
    const askBroker2 = mkFakeAskBroker();
    const frontend2 = new SessionFrontend({
      sessionManager: sessionManager2,
      workspaceManager: mkFakeWm(),
      permissionBroker: mkFakeBroker(),
      askBroker: askBroker2,
      elicitationBroker: mkFakeElicBroker(),
      adapters: { telegram: adapter2 },
    });
    frontend2.start();
    sessionManager2.push({ kind: 'created', session: fakeSession2 } as Parameters<typeof sessionManager2.push>[0]);
    await flushAsync();

    const sendsBefore = adapter2.calls.filter(c => c.kind === 'send').length;
    askBroker2.push({
      kind: 'pending',
      sessionId: fakeSession2.id,
      request: {
        id: 'q1',
        prompt: 'pick one',
        options: ['Alpha', 'Beta'],
        resolve: () => { /* noop */ },
      },
    } as Parameters<typeof askBroker2.push>[0]);
    await flushAsync();

    const newSends = adapter2.calls.filter(c => c.kind === 'send').slice(sendsBefore);
    expect(newSends.length).toBeGreaterThanOrEqual(1);
    const askSend = newSends.find(s => /pick one/.test((s.args.text as string) ?? ''));
    expect(askSend).toBeTruthy();
    // Should have inline keyboard buttons for each option
    const markup = askSend?.args.replyMarkup as { buttons?: unknown[][] } | undefined;
    expect(markup?.buttons?.length).toBeGreaterThanOrEqual(2);

    frontend2.stop && await (frontend2 as unknown as { stop(): Promise<void> }).stop();
  });

  it('AskBroker pending → button click routes to broker.resolve via callback interceptor', async () => {
    const adapter2 = new FakeAdapter('telegram');
    const fakeSession2 = new FakeSession({ id: 'ask-sess-2', workspaceId: 'ux-ws-1' });
    const sessions2 = new Map([[fakeSession2.id, fakeSession2]]);
    const sessionManager2 = mkFakeSessionManager({ sessions: sessions2 });
    const askBroker2 = mkFakeAskBroker();
    let resolved: { rid: string; chosen: string[] } | null = null;
    // Add a resolve spy to the broker
    const origPush = askBroker2.push.bind(askBroker2);
    void origPush; // unused — we spy at the broker interface level
    (askBroker2 as unknown as { resolve: unknown }).resolve = vi.fn(
      (_sid: string, rid: string, chosen: string[]) => { resolved = { rid, chosen }; return true; },
    );
    const frontend2 = new SessionFrontend({
      sessionManager: sessionManager2,
      workspaceManager: mkFakeWm(),
      permissionBroker: mkFakeBroker(),
      askBroker: askBroker2,
      elicitationBroker: mkFakeElicBroker(),
      adapters: { telegram: adapter2 },
    });
    frontend2.start();
    sessionManager2.push({ kind: 'created', session: fakeSession2 } as Parameters<typeof sessionManager2.push>[0]);
    await flushAsync();

    askBroker2.push({
      kind: 'pending',
      sessionId: fakeSession2.id,
      request: {
        id: 'q2',
        prompt: 'choose',
        options: ['X', 'Y'],
        resolve: () => { /* noop */ },
      },
    } as Parameters<typeof askBroker2.push>[0]);
    await flushAsync();

    // Simulate button click for option index 1 ('Y') using new card format.
    adapter2.emit({
      channelType: 'telegram',
      chatId: '100',
      messageId: 'm-callback',
      userId: 'u1',
      kind: 'callback',
      callbackData: 'ask:q2:opt:1',
      at: 0,
    });
    await flushAsync();

    expect(resolved).toEqual(expect.objectContaining({ rid: 'q2', chosen: ['Y'] }));

    frontend2.stop && await (frontend2 as unknown as { stop(): Promise<void> }).stop();
  });

  it('AskBroker multi-select → button toggles then confirm resolves', async () => {
    const adapter2 = new FakeAdapter('telegram');
    const fakeSession2 = new FakeSession({ id: 'ask-sess-3', workspaceId: 'ux-ws-1' });
    const sessions2 = new Map([[fakeSession2.id, fakeSession2]]);
    const sessionManager2 = mkFakeSessionManager({ sessions: sessions2 });
    const askBroker2 = mkFakeAskBroker();
    let resolved: { rid: string; chosen: string[] } | null = null;
    (askBroker2 as unknown as { resolve: unknown }).resolve = vi.fn(
      (_sid: string, rid: string, chosen: string[]) => { resolved = { rid, chosen }; return true; },
    );
    const frontend2 = new SessionFrontend({
      sessionManager: sessionManager2,
      workspaceManager: mkFakeWm(),
      permissionBroker: mkFakeBroker(),
      askBroker: askBroker2,
      elicitationBroker: mkFakeElicBroker(),
      adapters: { telegram: adapter2 },
    });
    frontend2.start();
    sessionManager2.push({ kind: 'created', session: fakeSession2 } as Parameters<typeof sessionManager2.push>[0]);
    await flushAsync();

    askBroker2.push({
      kind: 'pending',
      sessionId: fakeSession2.id,
      request: {
        id: 'q3',
        prompt: 'multi',
        options: ['P', 'Q', 'R'],
        multiSelect: true,
        resolve: () => { /* noop */ },
      },
    } as Parameters<typeof askBroker2.push>[0]);
    await flushAsync();

    // Toggle option 0 (P) and option 2 (R)
    adapter2.emit({ channelType: 'telegram', chatId: '100', messageId: 'm1', userId: 'u1', kind: 'callback', callbackData: 'ask:q3:opt:0', at: 0 });
    await flushAsync();
    adapter2.emit({ channelType: 'telegram', chatId: '100', messageId: 'm1', userId: 'u1', kind: 'callback', callbackData: 'ask:q3:opt:2', at: 0 });
    await flushAsync();
    // Confirm
    adapter2.emit({ channelType: 'telegram', chatId: '100', messageId: 'm1', userId: 'u1', kind: 'callback', callbackData: 'ask:q3:confirm', at: 0 });
    await flushAsync();

    expect(resolved).toEqual(expect.objectContaining({ rid: 'q3', chosen: ['P', 'R'] }));

    frontend2.stop && await (frontend2 as unknown as { stop(): Promise<void> }).stop();
  });

  it('AskBroker resolved event cleans up activeAskCards registry', async () => {
    const adapter2 = new FakeAdapter('telegram');
    const fakeSession2 = new FakeSession({ id: 'ask-sess-4', workspaceId: 'ux-ws-1' });
    const sessions2 = new Map([[fakeSession2.id, fakeSession2]]);
    const sessionManager2 = mkFakeSessionManager({ sessions: sessions2 });
    const askBroker2 = mkFakeAskBroker();
    const frontend2 = new SessionFrontend({
      sessionManager: sessionManager2,
      workspaceManager: mkFakeWm(),
      permissionBroker: mkFakeBroker(),
      askBroker: askBroker2,
      elicitationBroker: mkFakeElicBroker(),
      adapters: { telegram: adapter2 },
    });
    frontend2.start();
    sessionManager2.push({ kind: 'created', session: fakeSession2 } as Parameters<typeof sessionManager2.push>[0]);
    await flushAsync();

    askBroker2.push({
      kind: 'pending',
      sessionId: fakeSession2.id,
      request: { id: 'q4', prompt: 'p', options: ['A'], resolve: () => { /* noop */ } },
    } as Parameters<typeof askBroker2.push>[0]);
    await flushAsync();

    // Simulate resolved event coming back from broker
    askBroker2.push({
      kind: 'resolved',
      sessionId: fakeSession2.id,
      requestId: 'q4',
      chosen: ['A'],
    } as Parameters<typeof askBroker2.push>[0]);
    await flushAsync();

    // After resolved, a callback for the old request should be silently dropped
    // (no crash) — the card is gone from the registry.
    expect(() => {
      adapter2.emit({ channelType: 'telegram', chatId: '100', messageId: 'm1', userId: 'u1', kind: 'callback', callbackData: 'ask:q4:opt:0', at: 0 });
    }).not.toThrow();
    await flushAsync();

    frontend2.stop && await (frontend2 as unknown as { stop(): Promise<void> }).stop();
  });

  // ---------------------------------------------------------------------------
  // T10a: PermissionBroker → PermissionCard (generic, new UX path)
  // ---------------------------------------------------------------------------

  it('PermissionBroker pending → renders PermissionCard via send (new path)', async () => {
    const { adapter, permissionBroker, fakeSession } = await bootstrapFrontend();
    fakeSession.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 0 });
    await flushAsync();
    permissionBroker.push({
      kind: 'pending',
      sessionId: fakeSession.id,
      request: {
        id: 'rq1', category: 'exec', toolName: 'Bash', toolInput: { command: 'ls' },
        resolve: () => { /* noop */ },
      },
    } as Parameters<typeof permissionBroker.push>[0]);
    await flushAsync();
    const sends = adapter.calls.filter(c => c.kind === 'send');
    // 1 HUD + 1 PermissionCard send.
    expect(sends.length).toBeGreaterThanOrEqual(2);
    const permSend = sends.find(s => /Bash/.test((s.args.text as string) ?? ''));
    expect(permSend).toBeTruthy();
    // Buttons should include all 4 verbs.
    const buttons = (permSend!.args.replyMarkup as any)?.buttons?.flat() ?? [];
    const labels = buttons.map((b: any) => b.text);
    expect(labels).toEqual(expect.arrayContaining(['✅ Allow', '❌ Deny', '🔄 Always', '💡 Learn']));
  });

  it('PermissionBroker pending → callback resolves via permissionBroker.resolve', async () => {
    const { adapter, permissionBroker, fakeSession } = await bootstrapFrontend();
    let resolved: any = null;
    (permissionBroker as any).resolve = vi.fn((sid: string, rid: string, decision: any) => {
      resolved = { sid, rid, decision };
    });
    fakeSession.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 0 });
    await flushAsync();
    permissionBroker.push({
      kind: 'pending', sessionId: fakeSession.id,
      request: { id: 'rq2', category: 'exec', toolName: 'Bash', toolInput: {}, resolve: () => { /* noop */ } },
    } as Parameters<typeof permissionBroker.push>[0]);
    await flushAsync();
    // Find the permission card send.
    const permSend = adapter.calls.find(c => c.kind === 'send' && /Bash/.test((c.args.text as string) ?? ''))!;
    expect(permSend).toBeTruthy();
    adapter.emit({
      channelType: 'telegram', chatId: permSend.args.chatId as string,
      messageId: 'm1', userId: 'u1', kind: 'callback', callbackData: 'perm:rq2:allow', at: 0,
    } as any);
    await flushAsync();
    expect(resolved).toEqual(expect.objectContaining({ rid: 'rq2', decision: 'allow' }));
  });

  it('PermissionBroker resolved event cleans up activePermCards', async () => {
    const { permissionBroker, fakeSession, frontend } = await bootstrapFrontend();
    fakeSession.emit({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 0 });
    await flushAsync();
    permissionBroker.push({
      kind: 'pending', sessionId: fakeSession.id,
      request: { id: 'rq3', category: 'exec', toolName: 'Bash', toolInput: {}, resolve: () => { /* noop */ } },
    } as Parameters<typeof permissionBroker.push>[0]);
    await flushAsync();
    permissionBroker.push({
      kind: 'resolved', sessionId: fakeSession.id, requestId: 'rq3', decision: 'allow',
    } as Parameters<typeof permissionBroker.push>[0]);
    await flushAsync();
    // Internal state check: card should have been removed from registry.
    const entry = (frontend as any).sessions.get(fakeSession.id);
    expect(entry?.activePermCards?.has('rq3')).toBe(false);
  });
});
