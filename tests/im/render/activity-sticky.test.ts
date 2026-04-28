import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityStickyRenderer, ACTIVITY_EDIT_THROTTLE_MS } from '../../../src/im/render/activity-sticky.js';
import { CAPABILITIES } from '../../../src/im/capability-matrix.js';
import { newSessionRenderState, newTurnRenderState } from '../../../src/im/render/types.js';
import { FakeAdapter } from '../fake-adapter.js';

function setup() {
  const adapter = new FakeAdapter('telegram');
  const state = newSessionRenderState({
    sessionId: 's1', shortAlias: 'abcd',
    workspaceId: 'w1', workspaceName: 'app',
    targets: [{ channelType: 'telegram', chatId: '5', role: 'primary' }],
  });
  state.turn = newTurnRenderState('t1', 1_000_000, 0);
  let now = 1_000_000;
  const target = state.targets[0]!;
  const r = new ActivityStickyRenderer({
    adapter, capabilities: CAPABILITIES.telegram, session: state, target,
    clock: () => now,
  });
  return { adapter, state, r, setNow(ms: number) { now = ms; }, getNow() { return now; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ActivityStickyRenderer', () => {
  it('first phase-transition flushes immediately', async () => {
    const { adapter, r } = setup();
    await r.onEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 1_000_000 });
    expect(adapter.byKind('send')).toHaveLength(1);
  });

  it('non-phase events within 1.5s are deferred (no extra send/edit)', async () => {
    const { adapter, r, state, setNow } = setup();
    await r.onEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 1_000_000 });
    expect(adapter.byKind('send')).toHaveLength(1);
    setNow(1_000_500);
    state.turn!.currentTool = 'X'; // simulate state mutation
    await r.onEvent({ kind: 'heartbeat', elapsedMs: 500 });
    // still within throttle — no new edit yet
    expect(adapter.byKind('edit')).toHaveLength(0);
  });

  it('tool_use_start forces immediate edit', async () => {
    const { adapter, r, state, setNow } = setup();
    await r.onEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 1_000_000 });
    setNow(1_000_100);
    state.turn!.currentTool = 'Bash';
    await r.onEvent({
      kind: 'tool_use_start', turnId: 't1', toolUseId: 'u1', toolName: 'Bash', input: {},
    });
    expect(adapter.byKind('edit').length + adapter.byKind('send').length).toBeGreaterThanOrEqual(1);
    const calls = adapter.calls;
    const lastCall = calls[calls.length - 1];
    const lastText = lastCall!.kind === 'edit' ? lastCall!.args.text : lastCall!.args.text;
    expect(String(lastText)).toContain('Bash');
  });

  it('respects throttle constant', () => {
    expect(ACTIVITY_EDIT_THROTTLE_MS).toBe(1500);
  });

  // runtime_error must surface in the sticky text so the user sees what
  // actually went wrong instead of a silent disappearance.
  it('runtime_error surfaces an error banner in the sticky text', async () => {
    const { adapter, r } = setup();
    await r.onEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: 'hi', at: 1_000_000 });
    await r.onEvent({
      kind: 'runtime_error', severity: 'warn', code: 'API_429',
      message: 'rate limited',
    });
    const calls = adapter.calls;
    const last = calls[calls.length - 1]!;
    const text = String((last.kind === 'edit' ? last.args.text : last.args.text) ?? '');
    expect(text).toContain('rate limited');
    expect(text).toContain('API_429');
  });

  it('fatal runtime_error keeps the sticky alive on turn_end', async () => {
    const { adapter, r } = setup();
    await r.onEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 1_000_000 });
    await r.onEvent({
      kind: 'runtime_error', severity: 'fatal', code: 'OOM', message: 'out of memory',
    });
    await r.onEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0, tokensIn: 0, tokensOut: 0,
    });
    // Should NOT have called delete on the sticky.
    expect(adapter.byKind('delete')).toHaveLength(0);
  });

  it('warn runtime_error allows turn_end to delete the sticky', async () => {
    const { adapter, r } = setup();
    await r.onEvent({ kind: 'turn_start', turnId: 't1', userInputPreview: '', at: 1_000_000 });
    await r.onEvent({
      kind: 'runtime_error', severity: 'warn', code: 'API_429', message: 'throttled',
    });
    await r.onEvent({
      kind: 'turn_end', turnId: 't1', durationMs: 1, costUsd: 0, tokensIn: 0, tokensOut: 0,
    });
    expect(adapter.byKind('delete')).toHaveLength(1);
  });
});
