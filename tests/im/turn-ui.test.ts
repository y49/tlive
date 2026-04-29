import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnUI } from '../../src/im/turn-ui.js';
import { initialHudState } from '../../src/im/hud/state.js';
import { TelegramHudPanel } from '../../src/im/hud/telegram-panel.js';
import { FakeAdapter } from './fake-adapter.js';
import type { RenderTarget } from '../../src/im/render-target.js';

function newAdapter() { return new FakeAdapter('telegram'); }
function tgt(chatId: string): RenderTarget { return { channelType: 'telegram', chatId, role: 'primary' }; }

function makeUI(adapter: FakeAdapter, targets: RenderTarget[]) {
  const state = initialHudState({
    sessionShortId: 'abc', workspaceName: 'w', provider: 'claude',
    model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
    startedAtMs: 0, costSession: 0,
  });
  return new TurnUI(state, targets, target => new TelegramHudPanel(adapter, target));
}

describe('TurnUI', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start() sends one HUD per primary target', async () => {
    const adapter = newAdapter();
    const ui = makeUI(adapter, [tgt('c1'), tgt('c2')]);
    await ui.start();
    expect(adapter.calls.filter(c => c.kind === 'send')).toHaveLength(2);
  });

  it('ingestEvent debounces multiple updates into one edit (250ms)', async () => {
    const adapter = newAdapter();
    const ui = makeUI(adapter, [tgt('c1')]);
    await ui.start();
    await ui.ingestEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 0 });
    await ui.ingestEvent({ kind: 'tool_use_start', turnId: 't1', toolUseId: 'u1', toolName: 'Read', input: { file_path: 'a.ts' } });
    await ui.ingestEvent({ kind: 'tool_use_result', toolUseId: 'u1', output: '', durationMs: 1, ok: true });

    expect(adapter.calls.filter(c => c.kind === 'edit')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.calls.filter(c => c.kind === 'edit').length).toBeGreaterThanOrEqual(1);
  });

  it('turn_end flushes pending update + emits final freeze edit', async () => {
    const adapter = newAdapter();
    const ui = makeUI(adapter, [tgt('c1')]);
    await ui.start();
    await ui.ingestEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 0 });
    await ui.ingestEvent({ kind: 'turn_end', turnId: 't1', durationMs: 1000, costUsd: 0.01, tokensIn: 0, tokensOut: 0 });
    await vi.advanceTimersByTimeAsync(300);
    const editsWithDone = adapter.calls.filter(c => c.kind === 'edit' && /done/i.test((c.args.text as string) ?? ''));
    expect(editsWithDone.length).toBeGreaterThanOrEqual(1);
  });

  it('after destroy(), subsequent ingestEvent is silently dropped', async () => {
    const adapter = newAdapter();
    const ui = makeUI(adapter, [tgt('c1')]);
    await ui.start();
    ui.destroy();
    await ui.ingestEvent({ kind: 'tool_use_start', turnId: 't1', toolUseId: 'u', toolName: 'Bash', input: {} });
    await vi.advanceTimersByTimeAsync(500);
    expect(adapter.calls.filter(c => c.kind === 'edit')).toHaveLength(0);
  });

  it('30s after freeze() the UI is destroyed automatically', async () => {
    const adapter = newAdapter();
    const ui = makeUI(adapter, [tgt('c1')]);
    await ui.start();
    await ui.ingestEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 0, costUsd: 0, tokensIn: 0, tokensOut: 0,
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ui.isDestroyed()).toBe(true);
  });

  it('mirror targets receive no HUD panels', async () => {
    const adapter = newAdapter();
    const ui = makeUI(adapter, [
      { channelType: 'telegram', chatId: 'primary', role: 'primary' },
      { channelType: 'telegram', chatId: 'mirror', role: 'mirror' },
    ]);
    await ui.start();
    expect(adapter.calls.filter(c => c.kind === 'send')).toHaveLength(1);
    expect(adapter.calls[0].args.chatId).toBe('primary');
  });

  it('failure to send HUD on one target does not block others', async () => {
    const adapter = newAdapter();
    let calls = 0;
    const realSend = adapter.send.bind(adapter);
    adapter.send = async (msg) => {
      calls++;
      if (msg.chatId === 'bad') throw new Error('chat not found');
      return await realSend(msg);
    };
    const ui = makeUI(adapter, [tgt('bad'), tgt('good')]);
    await ui.start();
    expect(calls).toBe(2);
    await ui.ingestEvent({ kind: 'tool_use_start', turnId: 't1', toolUseId: 'u', toolName: 'Bash', input: {} });
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.calls.some(c => c.kind === 'edit' && c.args.chatId === 'good')).toBe(true);
    expect(adapter.calls.some(c => c.kind === 'edit' && c.args.chatId === 'bad')).toBe(false);
  });
});
