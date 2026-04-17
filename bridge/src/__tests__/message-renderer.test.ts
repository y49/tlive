import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRenderer } from '../engine/message-renderer.js';
import type { UsageStats } from '../engine/cost-tracker.js';

describe('MessageRenderer', () => {
  let flushCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCallback = vi.fn().mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) return Promise.resolve('msg-1');
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createRenderer(platformLimit = 4096, throttleMs = 300, displayMode: 'compact' | 'verbose' = 'verbose') {
    return new MessageRenderer({
      platformLimit,
      throttleMs,
      displayMode,
      flushCallback: flushCallback as any,
    });
  }

  /** Advance time and drain microtasks (promises) without triggering infinite interval loops */
  async function advance(ms: number) {
    vi.advanceTimersByTime(ms);
    // Drain promise queue (multiple rounds for chained promises)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  const defaultStats: UsageStats = {
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.05,
    durationMs: 10000,
  };

  const defaultButtons = [
    { label: 'Allow', callbackData: 'perm:allow:abc', style: 'primary' },
    { label: 'Deny', callbackData: 'perm:deny:abc', style: 'danger' },
  ];

  // ─── Executing phase ─────────────────────────────

  describe('executing phase', () => {
    it('shows single tool with count', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      // 1s elapsed tick fires, which schedules a flush (300ms throttle)
      await advance(1300);
      expect(flushCallback).toHaveBeenCalled();
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('⏳');
      expect(content).toContain('🖥️');
      expect(content).toContain('Bash');
      expect(content).toContain('×1');
      expect(content).toContain('1 tools');
      r.dispose();
    });

    it('shows compact executing view for weak channels', async () => {
      const r = createRenderer(4096, 300, 'compact');
      r.onToolStart('Bash');
      r.onToolStart('Read');
      await advance(1300);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('⏳ Working… 2 tools · 1s');
      expect(content).not.toContain('Bash ×1');
      expect(content).not.toContain('Read ×1');
      r.dispose();
    });

    it('shows multiple tool types in insertion order', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onToolStart('Grep');
      await advance(1300);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('🖥️ Bash ×2');
      expect(content).toContain('📖 Read ×2');
      expect(content).toContain('🔍 Grep ×1');
      expect(content).toContain('5 tools');
      // Check insertion order: Bash before Read before Grep
      const bashIdx = content.indexOf('Bash');
      const readIdx = content.indexOf('Read');
      const grepIdx = content.indexOf('Grep');
      expect(bashIdx).toBeLessThan(readIdx);
      expect(readIdx).toBeLessThan(grepIdx);
      r.dispose();
    });

    it('uses fallback icon for unknown tools', async () => {
      const r = createRenderer();
      r.onToolStart('CustomTool');
      await advance(1300);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('🔧');
      expect(content).toContain('CustomTool');
      r.dispose();
    });

    it('throttles flushes at the configured interval', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      // At 100ms — no flush yet (300ms throttle hasn't expired)
      await advance(100);
      expect(flushCallback).not.toHaveBeenCalled();
      // At 300ms — throttle fires, first flush
      await advance(200);
      expect(flushCallback).toHaveBeenCalledTimes(1);
      // Subsequent tool starts are also throttled
      r.onToolStart('Read');
      await advance(100);
      expect(flushCallback).toHaveBeenCalledTimes(1); // still throttled
      await advance(200);
      expect(flushCallback).toHaveBeenCalledTimes(2); // second flush
      r.dispose();
    });

    it('shows elapsed time in seconds', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      // Advance 3s + 300ms throttle
      await advance(3300);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('3s');
      r.dispose();
    });

    it('renders Starting... before any tool', async () => {
      const r = createRenderer();
      // Trigger a permission prompt with no tools to force a flush
      r.onPermissionNeeded('Bash', 'npm test', '123', defaultButtons);
      await advance(300);
      // Now resolve the permission to go back to executing phase
      r.onPermissionResolved();
      await advance(300);
      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      const content = lastCall[0] as string;
      expect(content).toBe('⏳ Starting...');
      r.dispose();
    });
  });

  // ─── Permission phase ────────────────────────────

  describe('permission phase', () => {
    it('morphs message to permission request', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', 'npm test -- schema.test.ts', 'perm-1', defaultButtons);
      await advance(300);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('🔐');
      expect(content).toContain('Bash');
      expect(content).toContain('npm test -- schema.test.ts');
      r.dispose();
    });

    it('passes buttons through during permission phase', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', 'rm -rf /', 'perm-1', defaultButtons);
      await advance(300);
      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      expect(lastCall[2]).toEqual(defaultButtons);
      r.dispose();
    });

    it('shows full permission input without truncation', async () => {
      const r = createRenderer();
      const longInput = 'a'.repeat(200);
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', longInput, 'perm-1', defaultButtons);
      await advance(300);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain(longInput);
      r.dispose();
    });

    it('restores executing state after permission resolved', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onPermissionNeeded('Bash', 'rm -rf /', 'perm-1', defaultButtons);
      await advance(300);

      r.onPermissionResolved();
      await advance(1300);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('⏳');
      expect(content).toContain('Bash ×1');
      expect(content).toContain('Read ×1');
      expect(content).not.toContain('🔐');
      r.dispose();
    });

    it('does not pass buttons after permission resolved', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', 'cmd', 'perm-1', defaultButtons);
      await advance(300);

      r.onPermissionResolved();
      await advance(1300);
      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      expect(lastCall[2]).toBeUndefined();
      r.dispose();
    });

    it('emits timeout reminder after 60s', async () => {
      let timeoutData: { toolName: string; input: string } | null = null;
      const r = new MessageRenderer({
        platformLimit: 4096,
        throttleMs: 300,
        flushCallback: flushCallback as any,
        onPermissionTimeout: (toolName, input, _buttons) => {
          timeoutData = { toolName, input };
        },
      });

      r.onToolStart('Bash');
      await advance(300);

      const buttons = [
        { label: '✅ Yes', callbackData: 'perm:allow:123', style: 'primary' },
        { label: '❌ No', callbackData: 'perm:deny:123', style: 'danger' },
      ];
      r.onPermissionNeeded('Bash', 'npm test', '123', buttons);

      // Before 60s — no timeout
      await advance(59000);
      expect(timeoutData).toBeNull();

      // At 60s — timeout fires
      await advance(1000);
      expect(timeoutData).toEqual({ toolName: 'Bash', input: 'npm test' });

      r.onPermissionResolved();
      r.dispose();
    });

    it('does not fire timeout if permission resolved before 60s', async () => {
      let timeoutFired = false;
      const r = new MessageRenderer({
        platformLimit: 4096,
        throttleMs: 300,
        flushCallback: flushCallback as any,
        onPermissionTimeout: () => { timeoutFired = true; },
      });

      r.onToolStart('Bash');
      await advance(300);

      const buttons = [
        { label: '✅ Yes', callbackData: 'perm:allow:123', style: 'primary' },
        { label: '❌ No', callbackData: 'perm:deny:123', style: 'danger' },
      ];
      r.onPermissionNeeded('Bash', 'npm test', '123', buttons);
      await advance(30000); // 30s
      r.onPermissionResolved();
      await advance(60000); // well past 60s
      expect(timeoutFired).toBe(false);

      r.dispose();
    });
  });

  // ─── Done phase ──────────────────────────────────

  describe('done phase', () => {
    it('shows response text + separator + tool summary + cost', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onToolStart('Read');
      r.onTextDelta('Here is the result.');
      r.onComplete(defaultStats);
      await advance(0); // drain microtasks
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('Here is the result.');
      expect(content).toContain('───────────────');
      expect(content).toContain('🖥️ Bash ×1');
      expect(content).toContain('📖 Read ×2');
      expect(content).toContain('3 total');
      expect(content).toContain('📊');
      expect(content).toContain('$0.05');
      r.dispose();
    });

    it('omits separator when response is empty', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onComplete(defaultStats);
      await advance(0);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).not.toContain('───────────────');
      expect(content).toContain('🖥️ Bash ×1');
      expect(content).toContain('1 total');
      expect(content).toContain('📊');
      r.dispose();
    });

    it('shows error with tools as stopped + footer', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onError('connection lost');
      await advance(0);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('⚠️ Stopped');
      expect(content).toContain('───────────────');
      expect(content).toContain('🖥️ Bash ×1');
      expect(content).toContain('📖 Read ×1');
      r.dispose();
    });

    it('shows error without tools as simple error message', async () => {
      const r = createRenderer();
      r.onError('connection refused');
      await advance(0);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toBe('❌ connection refused');
      expect(content).not.toContain('───────────────');
      r.dispose();
    });

    it('filters hidden tools from counts and display', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('TodoWrite');
      r.onToolStart('TaskCreate');
      r.onToolStart('ToolSearch');
      r.onToolStart('Read');
      r.onComplete(defaultStats);
      await advance(0);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('2 total');
      expect(content).not.toContain('TodoWrite');
      expect(content).not.toContain('TaskCreate');
      expect(content).not.toContain('ToolSearch');
      r.dispose();
    });

    it('shows error with partial text + footer', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onTextDelta('Partial response...');
      r.onError('stream interrupted');
      await advance(0);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('Partial response...');
      expect(content).toContain('⚠️ Stopped');
      expect(content).toContain('───────────────');
      r.dispose();
    });
  });

  // ─── Flush mechanics ─────────────────────────────

  describe('flush mechanics', () => {
    it('first flush sends new message, subsequent are edits', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      await advance(1300);
      expect(flushCallback).toHaveBeenCalledWith(expect.any(String), false, undefined);
      expect(r.messageId).toBe('msg-1');

      // Trigger another flush via elapsed tick
      await advance(1300);
      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      expect(lastCall[1]).toBe(true); // isEdit
      r.dispose();
    });

    it('prevents concurrent flushes with double-buffering', async () => {
      let resolveFirst: () => void;
      const slowCallback = vi.fn().mockImplementation((_content: string, isEdit: boolean) => {
        if (!isEdit) {
          return new Promise<string>((resolve) => {
            resolveFirst = () => resolve('msg-1');
          });
        }
        return Promise.resolve();
      });
      const r = new MessageRenderer({
        platformLimit: 4096,
        throttleMs: 300,
        flushCallback: slowCallback as any,
      });

      r.onToolStart('Bash');
      // elapsed tick at 1s, throttle at 1.3s
      await advance(1300);
      // First flush is now in-flight (not resolved)
      expect(slowCallback).toHaveBeenCalledTimes(1);

      // Second elapsed tick at 2s, throttle at 2.3s
      await advance(1000);
      // Second scheduleFlush triggers, but doFlush sees flushing=true
      // so it sets pendingFlush=true
      r.onToolStart('Read');
      await advance(300);

      // Still only one call since flushing guard blocks second
      expect(slowCallback).toHaveBeenCalledTimes(1);

      // Resolve first flush
      resolveFirst!();
      await advance(0);

      // Pending flush should have triggered a retry
      expect(slowCallback).toHaveBeenCalledTimes(2);
      expect(r.messageId).toBe('msg-1');
      r.dispose();
    });

    it('done phase passes full content (no platform limit truncation)', async () => {
      const r = createRenderer(200);
      r.onToolStart('Bash');
      r.onTextDelta('x'.repeat(500));
      r.onComplete(defaultStats);
      await advance(0);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      // Done phase does NOT truncate — bridge-manager handles overflow chunking
      expect(content.length).toBeGreaterThan(200);
      expect(content).toContain('x'.repeat(500));
      r.dispose();
    });

    it('executing phase still applies platform limit truncation', async () => {
      const r = createRenderer(200);
      // Add many different tool types to exceed the limit
      for (let i = 0; i < 20; i++) {
        r.onToolStart(`LongToolName${i}`);
      }
      await advance(300);
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content.length).toBeLessThanOrEqual(200);
      expect(content.startsWith('...\n')).toBe(true);
      r.dispose();
    });

    it('dispose clears timers', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.dispose();
      await advance(5000);
      expect(flushCallback).not.toHaveBeenCalled();
    });
  });

  // ─── Elapsed time ────────────────────────────────

  describe('elapsed time', () => {
    it('ticks every second and re-renders', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      // After 1s tick + 300ms throttle
      await advance(1300);
      const content1 = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content1).toContain('1s');

      // After 2s tick + 300ms throttle (at t=2300)
      await advance(1000);
      const content2 = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content2).toContain('2s');
      r.dispose();
    });

    it('stops ticking after complete', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      await advance(2000);

      const callsBefore = flushCallback.mock.calls.length;
      r.onComplete(defaultStats);
      await advance(0);
      const callsAfterComplete = flushCallback.mock.calls.length;
      expect(callsAfterComplete).toBeGreaterThan(callsBefore);

      // Advance more time — no more flushes
      await advance(5000);
      expect(flushCallback.mock.calls.length).toBe(callsAfterComplete);
      r.dispose();
    });
  });

  // ─── Full lifecycle integration ──────────────────

  describe('full lifecycle integration', () => {
    it('tools → permission → more tools → done', async () => {
      const r = createRenderer();

      // Phase 1: tools executing
      r.onToolStart('Read');
      r.onToolStart('Read');
      r.onToolComplete('t1');
      r.onToolComplete('t2');
      await advance(1300);
      let content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('⏳');
      expect(content).toContain('📖 Read ×2');

      // Phase 2: permission needed
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', 'npm test', 'perm-1', defaultButtons);
      await advance(300);
      content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('🔐');
      expect(content).toContain('npm test');

      // Phase 3: permission resolved, more tools
      r.onPermissionResolved();
      r.onToolStart('Bash');
      r.onToolStart('Grep');
      await advance(1300);
      content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('⏳');
      expect(content).toContain('Read ×2');
      expect(content).toContain('Bash ×2');
      expect(content).toContain('Grep ×1');

      // Phase 4: complete
      r.onTextDelta('All done!');
      r.onComplete(defaultStats);
      await advance(0);
      content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('All done!');
      expect(content).toContain('───────────────');
      expect(content).toContain('5 total');
      expect(content).toContain('📊');
      r.dispose();
    });
  });

  // ─── getResponseText ─────────────────────────────

  describe('getResponseText', () => {
    it('returns accumulated text', () => {
      const r = createRenderer();
      r.onTextDelta('hello ');
      r.onTextDelta('world');
      expect(r.getResponseText()).toBe('hello world');
      r.dispose();
    });
  });

  // ─── onTextDelta ─────────────────────────────────

  describe('onTextDelta', () => {
    it('flushes text during accumulation', async () => {
      const r = createRenderer();
      r.onTextDelta('hello ');
      r.onTextDelta('world');
      await advance(300);
      expect(flushCallback).toHaveBeenCalled();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('hello world');
      r.dispose();
    });
  });
});
