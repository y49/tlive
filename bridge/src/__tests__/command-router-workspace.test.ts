import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CommandRouter } from '../engine/command-router.js';
import type { SessionController } from '../engine/command-router.js';
import { WorkspaceManager } from '../engine/workspace-manager.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { SessionStateManager } from '../engine/session-state.js';
import type { ChannelRouter } from '../engine/router.js';
import type { QueryControls } from '../providers/base.js';
import type { ChannelType, InboundMessage } from '../channels/types.js';
import type { NotificationRenderer } from '../renderers/types.js';
import { TelegramRenderer } from '../renderers/telegram.js';
import { DiscordRenderer } from '../renderers/discord.js';
import { FeishuRenderer } from '../renderers/feishu.js';

function mockAdapter(channelType = 'telegram'): BaseChannelAdapter {
  return {
    channelType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    consumeOne: vi.fn().mockResolvedValue(null),
    send: vi.fn().mockResolvedValue({ messageId: 'msg1', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    validateConfig: vi.fn().mockReturnValue(null),
    isAuthorized: vi.fn().mockReturnValue(true),
  } as any;
}

function mockState(): SessionStateManager {
  return {
    getModel: vi.fn().mockReturnValue(undefined),
    getEffort: vi.fn().mockReturnValue(undefined),
    getPermMode: vi.fn().mockReturnValue('on'),
    getRuntime: vi.fn().mockReturnValue(undefined),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    setPermMode: vi.fn(),
    clearLastActive: vi.fn(),
    clearThread: vi.fn(),
    stateKey: vi.fn().mockImplementation((ct: string, id: string) => `${ct}:${id}`),
  } as any;
}

function mockRouter(): ChannelRouter {
  return {
    resolve: vi.fn().mockResolvedValue({ sessionId: 'current-session' }),
    rebind: vi.fn().mockResolvedValue({}),
  } as any;
}

function createRenderers(): Map<ChannelType, NotificationRenderer> {
  return new Map<ChannelType, NotificationRenderer>([
    ['telegram', new TelegramRenderer()],
    ['discord', new DiscordRenderer()],
    ['feishu', new FeishuRenderer()],
  ]);
}

function makeMsg(text: string, chatId = 'chat1', channelType = 'telegram'): InboundMessage {
  return { text, chatId, channelType, userId: 'u1', username: 'tester' } as any;
}

describe('CommandRouter /workspaces', () => {
  let router: CommandRouter;
  let adapter: ReturnType<typeof mockAdapter>;

  beforeEach(() => {
    const state = mockState();
    const channelRouter = mockRouter();
    const activeControls = new Map<string, QueryControls>();
    const permissions = { clearSessionWhitelist: vi.fn() };
    const renderers = createRenderers();

    router = new CommandRouter(
      state as any,
      () => new Map(),
      channelRouter as any,
      activeControls,
      permissions,
      undefined,
      renderers,
    );

    adapter = mockAdapter('telegram');
  });

  it('returns "not configured" when no WorkspaceManager is set', async () => {
    const result = await router.handle(adapter as any, makeMsg('/workspaces'));
    expect(result).toBe(true);
    expect(adapter.send).toHaveBeenCalledOnce();
    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound))
      .toContain('not configured');
  });

  it('returns empty list message when no workspaces exist', async () => {
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    router.setWorkspaceManager(mgr);

    const result = await router.handle(adapter as any, makeMsg('/workspaces'));
    expect(result).toBe(true);
    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('No workspaces');
  });

  it('lists both workspace names when two workspaces are registered', async () => {
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    mgr.register({ name: 'alpha', workdir: '/projects/alpha', runtime: 'claude' });
    mgr.register({ name: 'beta', workdir: '/projects/beta', runtime: 'codex' });

    router.setWorkspaceManager(mgr);

    const result = await router.handle(adapter as any, makeMsg('/workspaces'));
    expect(result).toBe(true);
    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
  });

  it('marks running workspace with ● and idle workspace with ○', async () => {
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    mgr.register({ name: 'active-ws', workdir: '/projects/active', runtime: 'claude' });
    mgr.register({ name: 'idle-ws', workdir: '/projects/idle', runtime: 'claude' });

    // Mark active-ws as running
    mgr.update('active-ws', { chatId: 'chat1', activeSessionId: 'sess-123' });

    router.setWorkspaceManager(mgr);

    const result = await router.handle(adapter as any, makeMsg('/workspaces'));
    expect(result).toBe(true);
    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);

    expect(text).toContain('● active-ws');
    expect(text).toContain('○ idle-ws');
    expect(text).toContain('running');
    expect(text).toContain('idle');
  });

  it('shows "never" when lastActivityAt is not set', async () => {
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    mgr.register({ name: 'fresh', workdir: '/projects/fresh', runtime: 'claude' });

    router.setWorkspaceManager(mgr);

    await router.handle(adapter as any, makeMsg('/workspaces'));
    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('never');
  });

  it('shows relative time when lastActivityAt is set', async () => {
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    mgr.register({ name: 'timed', workdir: '/projects/timed', runtime: 'claude' });
    // Set lastActivityAt to 5 minutes ago
    mgr.update('timed', { lastActivityAt: Date.now() - 5 * 60 * 1000 });

    router.setWorkspaceManager(mgr);

    await router.handle(adapter as any, makeMsg('/workspaces'));
    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    // 5 minutes ago → "5m ago"
    expect(text).toMatch(/\d+m ago/);
  });

  it('returns true (command consumed) for /workspaces', async () => {
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    router.setWorkspaceManager(mgr);
    const result = await router.handle(adapter as any, makeMsg('/workspaces'));
    expect(result).toBe(true);
  });
});

describe('/open', () => {
  let router: CommandRouter;
  let adapter: ReturnType<typeof mockAdapter>;

  beforeEach(() => {
    const state = mockState();
    const channelRouter = mockRouter();
    const activeControls = new Map();
    const permissions = { clearSessionWhitelist: vi.fn() };
    const renderers = createRenderers();

    router = new CommandRouter(
      state as any,
      () => new Map(),
      channelRouter as any,
      activeControls,
      permissions,
      undefined,
      renderers,
    );

    adapter = mockAdapter('telegram');
  });

  it('opens existing workspace by name', async () => {
    const tmpDir = mkdtempSync(`${tmpdir()}/open-test-`);
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    mgr.register({ name: 'alpha', workdir: tmpDir, runtime: 'claude' });
    router.setWorkspaceManager(mgr);

    const result = await router.handle(adapter as any, makeMsg('/open alpha', 'chat42'));
    expect(result).toBe(true);

    const ws = mgr.findByName('alpha');
    expect(ws?.chatId).toBe('chat42');

    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('alpha');
    expect(text).toContain('opened');
  });

  it('creates new workspace by path', async () => {
    const tmpDir = mkdtempSync(`${tmpdir()}/open-path-test-`);
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    router.setWorkspaceManager(mgr);

    const result = await router.handle(adapter as any, makeMsg(`/open ${tmpDir}`, 'chat99'));
    expect(result).toBe(true);

    const workspaces = mgr.list();
    expect(workspaces.length).toBe(1);
    expect(workspaces[0].workdir).toBe(tmpDir);
    expect(workspaces[0].chatId).toBe('chat99');

    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('opened');
    expect(text).toContain(tmpDir);
  });

  it('rejects /open with invalid path', async () => {
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    router.setWorkspaceManager(mgr);

    const result = await router.handle(adapter as any, makeMsg('/open /no/such/path/tlive-test'));
    expect(result).toBe(true);

    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('❌');
  });

  it('returns usage when no arg given', async () => {
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    router.setWorkspaceManager(mgr);

    const result = await router.handle(adapter as any, makeMsg('/open'));
    expect(result).toBe(true);

    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('Usage');
  });

  it('returns "not configured" when no WorkspaceManager is set', async () => {
    const result = await router.handle(adapter as any, makeMsg('/open alpha'));
    expect(result).toBe(true);

    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('not configured');
  });
});

describe('/stop', () => {
  let router: CommandRouter;
  let adapter: ReturnType<typeof mockAdapter>;
  let state: ReturnType<typeof mockState>;
  let activeControls: Map<string, any>;

  beforeEach(() => {
    state = mockState();
    const channelRouter = mockRouter();
    activeControls = new Map();
    const permissions = { clearSessionWhitelist: vi.fn() };
    const renderers = createRenderers();

    router = new CommandRouter(
      state as any,
      () => new Map(),
      channelRouter as any,
      activeControls,
      permissions,
      undefined,
      renderers,
    );

    adapter = mockAdapter('telegram');
  });

  it('clears activeSessionId but keeps workspace', async () => {
    const tmpDir = mkdtempSync(`${tmpdir()}/stop-test-`);
    const mgr = new WorkspaceManager({ persistPath: null, workdirWhitelist: undefined });
    mgr.register({ name: 'my-ws', workdir: tmpDir, runtime: 'codex' });
    // Simulate workspace linked to the chat with an active session
    mgr.update('my-ws', { chatId: 'chat1', activeSessionId: 'sess-abc' });
    router.setWorkspaceManager(mgr);

    const abortFn = vi.fn().mockResolvedValue(undefined);
    const ctrl: SessionController = { abort: abortFn };
    router.setSessionController(ctrl);

    const result = await router.handle(adapter as any, makeMsg('/stop', 'chat1'));
    expect(result).toBe(true);

    // Session was cleared
    const ws = mgr.findByName('my-ws');
    expect(ws).toBeDefined();
    expect(ws!.activeSessionId).toBeUndefined();
    expect(ws!.lastSessionId).toBe('sess-abc');

    // workspace itself still exists
    expect(mgr.list().length).toBe(1);

    // abort was called with the session id
    expect(abortFn).toHaveBeenCalledWith('sess-abc');

    // confirmation message sent
    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('⏹');
  });

  it('reports no active execution when no controls and no workspace session', async () => {
    const result = await router.handle(adapter as any, makeMsg('/stop', 'chat1'));
    expect(result).toBe(true);

    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('No active execution');
  });

  it('interrupts active QueryControls when present', async () => {
    // stateKey returns "telegram:chat1"
    const interruptFn = vi.fn().mockResolvedValue(undefined);
    const stopTaskFn = vi.fn().mockResolvedValue(undefined);
    activeControls.set('telegram:chat1', { interrupt: interruptFn, stopTask: stopTaskFn });

    const result = await router.handle(adapter as any, makeMsg('/stop', 'chat1'));
    expect(result).toBe(true);
    expect(interruptFn).toHaveBeenCalled();

    const [, outbound] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = outbound.html ?? outbound.text ?? outbound.content ?? JSON.stringify(outbound);
    expect(text).toContain('⏹');
  });
});
