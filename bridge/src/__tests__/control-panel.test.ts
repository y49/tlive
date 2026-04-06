import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ControlPanel } from '../engine/control-panel.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { SessionStateManager } from '../engine/session-state.js';
import type { SDKEngine } from '../engine/sdk-engine.js';
import type { ChannelRouter } from '../engine/router.js';
import type { QueryControls } from '../providers/base.js';
import type { OutboundMessage } from '../channels/types.js';

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

function mockSdkEngine(): SDKEngine {
  return {
    getCostTracker: vi.fn().mockReturnValue(null),
  } as any;
}

function mockRouter(): ChannelRouter {
  return {
    resolve: vi.fn().mockResolvedValue({ sessionId: 'current-session' }),
    rebind: vi.fn().mockResolvedValue({}),
  } as any;
}

describe('ControlPanel', () => {
  let panel: ControlPanel;
  let state: ReturnType<typeof mockState>;
  let sdkEngine: ReturnType<typeof mockSdkEngine>;
  let router: ReturnType<typeof mockRouter>;
  let controls: Map<string, QueryControls>;
  let onNewSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = mockState();
    sdkEngine = mockSdkEngine();
    router = mockRouter();
    controls = new Map();
    onNewSession = vi.fn();
    panel = new ControlPanel(state as any, sdkEngine as any, controls, router as any, onNewSession);
  });

  describe('buildMainPanel', () => {
    it('returns card with 6 buttons for telegram', () => {
      const msg = panel.buildMainPanel('telegram', 'chat1');
      expect(msg.chatId).toBe('chat1');
      expect(msg.html).toContain('TLive');
      expect(msg.buttons).toHaveLength(6);

      const labels = msg.buttons!.map(b => b.label);
      expect(labels).toContain('🤖 Model');
      expect(labels).toContain('📋 Sessions');
      expect(labels).toContain('⏹ Stop');
      expect(labels).toContain('📊 Stats');
    });

    it('returns embed with fields for discord', () => {
      const msg = panel.buildMainPanel('discord', 'chat1');
      expect(msg.embed?.title).toBe('⚙️ TLive');
      expect(msg.embed?.color).toBe(0x3399FF);
      expect(msg.embed?.fields).toBeDefined();
      expect(msg.embed?.fields?.length).toBeGreaterThanOrEqual(4);
      expect(msg.buttons).toHaveLength(6);
    });

    it('returns feishu card', () => {
      const msg = panel.buildMainPanel('feishu', 'chat1');
      expect(msg.feishuHeader?.title).toBe('⚙️ TLive');
      expect(msg.feishuHeader?.template).toBe('blue');
      expect(msg.buttons).toHaveLength(6);
    });

    it('reflects current state values', () => {
      (state.getModel as any).mockReturnValue('claude-opus-4-6');
      (state.getEffort as any).mockReturnValue('high');
      (state.getPermMode as any).mockReturnValue('off');
      (state.getRuntime as any).mockReturnValue('codex');

      const msg = panel.buildMainPanel('telegram', 'chat1');
      expect(msg.html).toContain('claude-opus-4-6');
      expect(msg.html).toContain('high');
      expect(msg.html).toContain('OFF');
      expect(msg.html).toContain('codex');
    });
  });

  describe('show', () => {
    it('sends main panel via adapter', async () => {
      const adapter = mockAdapter();
      await panel.show(adapter, 'chat1');
      expect(adapter.send).toHaveBeenCalledTimes(1);
      const sent = (adapter.send as any).mock.calls[0][0] as OutboundMessage;
      expect(sent.buttons).toHaveLength(6);
    });
  });

  describe('handleCallback', () => {
    it('model shows model picker', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'model:telegram:chat1');
      expect(adapter.editMessage).toHaveBeenCalledTimes(1);
      const edited = (adapter.editMessage as any).mock.calls[0][2] as OutboundMessage;
      expect(edited.html).toContain('Select Model');
    });

    it('model select updates state and returns to main panel', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'model:select:claude-opus-4-6:telegram:chat1');
      expect(state.setModel).toHaveBeenCalledWith('telegram', 'chat1', 'claude-opus-4-6');
      const edited = (adapter.editMessage as any).mock.calls[0][2] as OutboundMessage;
      expect(edited.html).toContain('⚙️ TLive');
    });

    it('model select default resets model', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'model:select:default:telegram:chat1');
      expect(state.setModel).toHaveBeenCalledWith('telegram', 'chat1', undefined);
    });

    it('effort shows effort picker', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'effort:telegram:chat1');
      const edited = (adapter.editMessage as any).mock.calls[0][2] as OutboundMessage;
      expect(edited.html).toContain('Select Effort');
    });

    it('effort select updates state and returns to main', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'effort:select:high:telegram:chat1');
      expect(state.setEffort).toHaveBeenCalledWith('telegram', 'chat1', 'high');
    });

    it('perm toggles permission mode', async () => {
      const adapter = mockAdapter();
      (state.getPermMode as any).mockReturnValue('on');
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'perm:telegram:chat1');
      expect(state.setPermMode).toHaveBeenCalledWith('telegram', 'chat1', 'off');
    });

    it('perm toggle off→on', async () => {
      const adapter = mockAdapter();
      (state.getPermMode as any).mockReturnValue('off');
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'perm:telegram:chat1');
      expect(state.setPermMode).toHaveBeenCalledWith('telegram', 'chat1', 'on');
    });

    it('stop interrupts active query', async () => {
      const adapter = mockAdapter();
      const ctrl = { interrupt: vi.fn().mockResolvedValue(undefined), stopTask: vi.fn() };
      controls.set('telegram:chat1', ctrl);
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'stop:telegram:chat1');
      expect(ctrl.interrupt).toHaveBeenCalled();
      expect(controls.has('telegram:chat1')).toBe(false);
    });

    it('stats shows stats card', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'stats:telegram:chat1');
      const edited = (adapter.editMessage as any).mock.calls[0][2] as OutboundMessage;
      expect(edited.html).toContain('Session Stats');
    });

    it('back returns to main panel', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'back:telegram:chat1');
      const edited = (adapter.editMessage as any).mock.calls[0][2] as OutboundMessage;
      expect(edited.html).toContain('⚙️ TLive');
    });
  });

  describe('buildModelPicker', () => {
    it('shows claude models by default', () => {
      const msg = panel.buildModelPicker('telegram', 'chat1');
      expect(msg.html).toContain('Select Model');
      const labels = msg.buttons!.map(b => b.label);
      expect(labels).toContain('claude-sonnet-4-6');
      expect(labels).toContain('claude-opus-4-6');
      expect(labels).toContain('claude-haiku-4-5');
      expect(labels).toContain('↩ Back');
    });

    it('shows codex models for codex runtime', () => {
      (state.getRuntime as any).mockReturnValue('codex');
      const msg = panel.buildModelPicker('telegram', 'chat1');
      const labels = msg.buttons!.map(b => b.label);
      expect(labels).toContain('codex-mini');
      expect(labels).toContain('o4-mini');
    });

    it('marks current model with checkmark', () => {
      (state.getModel as any).mockReturnValue('claude-opus-4-6');
      const msg = panel.buildModelPicker('telegram', 'chat1');
      const opusBtn = msg.buttons!.find(b => b.label.includes('claude-opus-4-6'));
      expect(opusBtn?.label).toBe('✓ claude-opus-4-6');
      expect(opusBtn?.style).toBe('primary');
    });
  });

  describe('buildEffortPicker', () => {
    it('shows 4 effort levels + back', () => {
      const msg = panel.buildEffortPicker('telegram', 'chat1');
      expect(msg.buttons).toHaveLength(5);
      const labels = msg.buttons!.map(b => b.label);
      expect(labels).toContain('⚡ Low');
      expect(labels).toContain('🧠 Medium');
      expect(labels).toContain('💪 High');
      expect(labels).toContain('🔥 Max');
      expect(labels).toContain('↩ Back');
    });

    it('marks current effort with checkmark', () => {
      (state.getEffort as any).mockReturnValue('high');
      const msg = panel.buildEffortPicker('telegram', 'chat1');
      const highBtn = msg.buttons!.find(b => b.label.includes('High'));
      expect(highBtn?.label).toBe('💪 High ✓');
      expect(highBtn?.style).toBe('primary');
    });
  });

  describe('buildStatsCard', () => {
    it('shows "no stats" when no tracker', () => {
      const msg = panel.buildStatsCard('telegram', 'chat1');
      // Grey card for empty state
      expect(msg.html).toContain('No stats available');
    });

    it('shows query count and cost when tracker exists', () => {
      (sdkEngine.getCostTracker as any).mockReturnValue({
        queryCount: 5,
        sessionTotalUsd: 1.47,
      });
      const msg = panel.buildStatsCard('telegram', 'chat1');
      expect(msg.html).toContain('5');
      expect(msg.html).toContain('$1.47');
    });

    it('discord stats use embed fields', () => {
      (sdkEngine.getCostTracker as any).mockReturnValue({
        queryCount: 3,
        sessionTotalUsd: 0.52,
      });
      const msg = panel.buildStatsCard('discord', 'chat1');
      expect(msg.embed?.title).toBe('📊 Session Stats');
      expect(msg.embed?.fields).toHaveLength(2);
    });
  });

  describe('session interactions', () => {
    it('session switch rebinds and returns to main panel', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'session:switch:sess-123:telegram:chat1');
      expect(router.rebind).toHaveBeenCalledWith('telegram', 'chat1', 'sess-123');
      expect(state.clearLastActive).toHaveBeenCalledWith('telegram', 'chat1');
      const edited = (adapter.editMessage as any).mock.calls[0][2] as OutboundMessage;
      expect(edited.html).toContain('⚙️ TLive');
    });

    it('session new creates new session and returns to main panel', async () => {
      const adapter = mockAdapter();
      await panel.handleCallback(adapter, 'chat1', 'msg1', 'session:new:telegram:chat1');
      expect(onNewSession).toHaveBeenCalledWith('telegram', 'chat1');
      expect(router.rebind).toHaveBeenCalled();
      expect(state.clearLastActive).toHaveBeenCalledWith('telegram', 'chat1');
      expect(state.clearThread).toHaveBeenCalledWith('telegram', 'chat1');
    });
  });

  describe('callback data format', () => {
    it('includes chatKey in all main panel buttons', () => {
      const msg = panel.buildMainPanel('telegram', 'chat1');
      for (const btn of msg.buttons!) {
        expect(btn.callbackData).toContain('telegram:chat1');
        expect(btn.callbackData).toMatch(/^panel:/);
      }
    });
  });
});
