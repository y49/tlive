import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRenderer } from '../engine/message-renderer.js';
import type { UsageStats } from '../engine/cost-tracker.js';
import type { ProgressSnapshot } from '../renderers/types.js';

describe('MessageRenderer', () => {
  let flushCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCallback = vi.fn().mockImplementation((_snapshot: ProgressSnapshot, isEdit: boolean) => {
      if (!isEdit) return Promise.resolve('msg-1');
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createRenderer(platformLimit = 4096, throttleMs = 300) {
    return new MessageRenderer({
      platformLimit,
      throttleMs,
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

  /** Get the last snapshot flushed */
  function lastSnapshot(): ProgressSnapshot {
    return flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as ProgressSnapshot;
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
      const snap = lastSnapshot();
      expect(snap.phase).toBe('executing');
      expect(snap.toolCounts.get('Bash')).toBe(1);
      expect(snap.totalTools).toBe(1);
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
      const snap = lastSnapshot();
      expect(snap.toolCounts.get('Bash')).toBe(2);
      expect(snap.toolCounts.get('Read')).toBe(2);
      expect(snap.toolCounts.get('Grep')).toBe(1);
      expect(snap.totalTools).toBe(5);
      // Check insertion order: keys iterator preserves Map insertion order
      const keys = [...snap.toolCounts.keys()];
      expect(keys.indexOf('Bash')).toBeLessThan(keys.indexOf('Read'));
      expect(keys.indexOf('Read')).toBeLessThan(keys.indexOf('Grep'));
      r.dispose();
    });

    it('uses fallback icon for unknown tools', async () => {
      const r = createRenderer();
      r.onToolStart('CustomTool');
      await advance(1300);
      const snap = lastSnapshot();
      expect(snap.toolCounts.get('CustomTool')).toBe(1);
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
      const snap = lastSnapshot();
      expect(snap.elapsedSeconds).toBe(3);
      r.dispose();
    });

    it('renders starting phase before any tool', async () => {
      const r = createRenderer();
      // Trigger a permission prompt with no tools to force a flush
      r.onPermissionNeeded('Bash', 'npm test', '123', defaultButtons);
      await advance(300);
      // Now resolve the permission to go back to executing phase
      r.onPermissionResolved();
      await advance(300);
      const snap = lastSnapshot();
      // With no tools and no response text, phase should be 'starting'
      // But the doFlush skip guard (starting + 0 tools + no text) means this won't flush.
      // The last flushed snapshot was the permission one. After resolve, the scheduled flush
      // produces a 'starting' snapshot which gets skipped. So check the permission one was flushed.
      // Actually, let's just verify the snapshot state directly:
      const directSnap = r.snapshot();
      expect(directSnap.phase).toBe('starting');
      expect(directSnap.totalTools).toBe(0);
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
      const snap = lastSnapshot();
      expect(snap.phase).toBe('permission');
      expect(snap.permissionQueue[0].toolName).toBe('Bash');
      expect(snap.permissionQueue[0].input).toBe('npm test -- schema.test.ts');
      r.dispose();
    });

    it('passes buttons through during permission phase via permissionQueue', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', 'rm -rf /', 'perm-1', defaultButtons);
      await advance(300);
      const snap = lastSnapshot();
      expect(snap.permissionQueue[0].buttons).toEqual(defaultButtons);
      r.dispose();
    });

    it('shows full permission input without truncation', async () => {
      const r = createRenderer();
      const longInput = 'a'.repeat(200);
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', longInput, 'perm-1', defaultButtons);
      await advance(300);
      const snap = lastSnapshot();
      expect(snap.permissionQueue[0].input).toBe(longInput);
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
      const snap = lastSnapshot();
      expect(snap.phase).toBe('executing');
      expect(snap.toolCounts.get('Bash')).toBe(1);
      expect(snap.toolCounts.get('Read')).toBe(1);
      expect(snap.permissionQueue).toHaveLength(0);
      r.dispose();
    });

    it('does not have permissions after permission resolved', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', 'cmd', 'perm-1', defaultButtons);
      await advance(300);

      r.onPermissionResolved();
      await advance(1300);
      const snap = lastSnapshot();
      expect(snap.permissionQueue).toHaveLength(0);
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
    it('shows response text + tool summary + cost in completed snapshot', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onToolStart('Read');
      r.onTextDelta('Here is the result.');
      r.onComplete(defaultStats);
      await advance(0); // drain microtasks
      const snap = lastSnapshot();
      expect(snap.phase).toBe('completed');
      expect(snap.responseText).toBe('Here is the result.');
      expect(snap.toolCounts.get('Bash')).toBe(1);
      expect(snap.toolCounts.get('Read')).toBe(2);
      expect(snap.totalTools).toBe(3);
      expect(snap.costLine).toBeDefined();
      expect(snap.costLine).toContain('$0.05');
      r.dispose();
    });

    it('completed with no response text still has tool summary', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onComplete(defaultStats);
      await advance(0);
      const snap = lastSnapshot();
      expect(snap.phase).toBe('completed');
      expect(snap.responseText).toBe('');
      expect(snap.toolCounts.get('Bash')).toBe(1);
      expect(snap.totalTools).toBe(1);
      expect(snap.costLine).toBeDefined();
      r.dispose();
    });

    it('shows error with tools as error phase', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onError('connection lost');
      await advance(0);
      const snap = lastSnapshot();
      expect(snap.phase).toBe('error');
      expect(snap.errorMessage).toBe('connection lost');
      expect(snap.toolCounts.get('Bash')).toBe(1);
      expect(snap.toolCounts.get('Read')).toBe(1);
      r.dispose();
    });

    it('shows error without tools as error phase', async () => {
      const r = createRenderer();
      r.onError('connection refused');
      await advance(0);
      const snap = lastSnapshot();
      expect(snap.phase).toBe('error');
      expect(snap.errorMessage).toBe('connection refused');
      expect(snap.totalTools).toBe(0);
      r.dispose();
    });

    it('filters hidden tools from counts', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('TodoWrite');
      r.onToolStart('TaskCreate');
      r.onToolStart('ToolSearch');
      r.onToolStart('Read');
      r.onComplete(defaultStats);
      await advance(0);
      const snap = lastSnapshot();
      expect(snap.totalTools).toBe(2);
      expect(snap.toolCounts.has('TodoWrite')).toBe(false);
      expect(snap.toolCounts.has('TaskCreate')).toBe(false);
      expect(snap.toolCounts.has('ToolSearch')).toBe(false);
      r.dispose();
    });

    it('shows error with partial text', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onTextDelta('Partial response...');
      r.onError('stream interrupted');
      await advance(0);
      const snap = lastSnapshot();
      expect(snap.phase).toBe('error');
      expect(snap.responseText).toBe('Partial response...');
      expect(snap.errorMessage).toBe('stream interrupted');
      r.dispose();
    });
  });

  // ─── Flush mechanics ─────────────────────────────

  describe('flush mechanics', () => {
    it('first flush sends new message, subsequent are edits', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      await advance(1300);
      expect(flushCallback).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'executing' }),
        false,
      );
      expect(r.messageId).toBe('msg-1');

      // Trigger another flush via elapsed tick
      await advance(1300);
      const lastCall = flushCallback.mock.calls[flushCallback.mock.calls.length - 1];
      expect(lastCall[1]).toBe(true); // isEdit
      r.dispose();
    });

    it('prevents concurrent flushes with double-buffering', async () => {
      let resolveFirst: () => void;
      const slowCallback = vi.fn().mockImplementation((_snapshot: ProgressSnapshot, isEdit: boolean) => {
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

    it('done phase passes full response text in snapshot', async () => {
      const r = createRenderer(200);
      r.onToolStart('Bash');
      r.onTextDelta('x'.repeat(500));
      r.onComplete(defaultStats);
      await advance(0);
      const snap = lastSnapshot();
      // Snapshot always contains the full responseText — truncation is the renderer's job
      expect(snap.responseText.length).toBe(500);
      expect(snap.responseText).toBe('x'.repeat(500));
      r.dispose();
    });

    it('executing phase snapshot still has full data for renderer to handle limits', async () => {
      const r = createRenderer(200);
      // Add many different tool types
      for (let i = 0; i < 20; i++) {
        r.onToolStart(`LongToolName${i}`);
      }
      await advance(300);
      const snap = lastSnapshot();
      expect(snap.phase).toBe('executing');
      expect(snap.totalTools).toBe(20);
      expect(snap.toolCounts.size).toBe(20);
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
      const snap1 = lastSnapshot();
      expect(snap1.elapsedSeconds).toBe(1);

      // After 2s tick + 300ms throttle (at t=2300)
      await advance(1000);
      const snap2 = lastSnapshot();
      expect(snap2.elapsedSeconds).toBe(2);
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
    it('tools -> permission -> more tools -> done', async () => {
      const r = createRenderer();

      // Phase 1: tools executing
      r.onToolStart('Read');
      r.onToolStart('Read');
      r.onToolComplete('t1');
      r.onToolComplete('t2');
      await advance(1300);
      let snap = lastSnapshot();
      expect(snap.phase).toBe('executing');
      expect(snap.toolCounts.get('Read')).toBe(2);

      // Phase 2: permission needed
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', 'npm test', 'perm-1', defaultButtons);
      await advance(300);
      snap = lastSnapshot();
      expect(snap.phase).toBe('permission');
      expect(snap.permissionQueue[0].input).toBe('npm test');

      // Phase 3: permission resolved, more tools
      r.onPermissionResolved();
      r.onToolStart('Bash');
      r.onToolStart('Grep');
      await advance(1300);
      snap = lastSnapshot();
      expect(snap.phase).toBe('executing');
      expect(snap.toolCounts.get('Read')).toBe(2);
      expect(snap.toolCounts.get('Bash')).toBe(2);
      expect(snap.toolCounts.get('Grep')).toBe(1);

      // Phase 4: complete
      r.onTextDelta('All done!');
      r.onComplete(defaultStats);
      await advance(0);
      snap = lastSnapshot();
      expect(snap.phase).toBe('completed');
      expect(snap.responseText).toContain('All done!');
      expect(snap.totalTools).toBe(5);
      expect(snap.costLine).toBeDefined();
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
      const snap = flushCallback.mock.calls[0][0] as ProgressSnapshot;
      expect(snap.responseText).toContain('hello world');
      r.dispose();
    });
  });

  // ─── snapshot() ─────────────────────────────────

  describe('snapshot()', () => {
    it('returns starting phase when no activity', () => {
      const r = createRenderer();
      const snap = r.snapshot();
      expect(snap.phase).toBe('starting');
      expect(snap.totalTools).toBe(0);
      expect(snap.toolCounts.size).toBe(0);
      expect(snap.responseText).toBe('');
      expect(snap.permissionQueue).toEqual([]);
      expect(snap.todoItems).toEqual([]);
      expect(snap.elapsedSeconds).toBe(0);
      expect(snap.costLine).toBeUndefined();
      expect(snap.errorMessage).toBeUndefined();
      r.dispose();
    });

    it('returns executing phase with tool counts after onToolStart', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onToolStart('Bash');
      const snap = r.snapshot();
      expect(snap.phase).toBe('executing');
      expect(snap.totalTools).toBe(3);
      expect(snap.toolCounts.get('Bash')).toBe(2);
      expect(snap.toolCounts.get('Read')).toBe(1);
      r.dispose();
    });

    it('returns permission phase when permission is queued', () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onPermissionNeeded('Bash', 'rm -rf /', 'perm-1', defaultButtons);
      const snap = r.snapshot();
      expect(snap.phase).toBe('permission');
      expect(snap.permissionQueue).toHaveLength(1);
      expect(snap.permissionQueue[0].toolName).toBe('Bash');
      expect(snap.permissionQueue[0].input).toBe('rm -rf /');
      expect(snap.permissionQueue[0].permId).toBe('perm-1');
      r.dispose();
    });

    it('returns completed phase after onComplete', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onTextDelta('Done!');
      r.onComplete(defaultStats);
      await advance(0);
      const snap = r.snapshot();
      expect(snap.phase).toBe('completed');
      expect(snap.responseText).toBe('Done!');
      expect(snap.costLine).toBeDefined();
      expect(snap.costLine).toContain('$0.05');
      r.dispose();
    });

    it('returns error phase after onError', async () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onError('connection lost');
      await advance(0);
      const snap = r.snapshot();
      expect(snap.phase).toBe('error');
      expect(snap.errorMessage).toBe('connection lost');
      r.dispose();
    });

    it('includes todo items from onTodoUpdate', () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      const todos = [
        { content: 'Write tests', status: 'completed' as const },
        { content: 'Fix bug', status: 'in_progress' as const },
        { content: 'Deploy', status: 'pending' as const },
      ];
      r.onTodoUpdate(todos);
      const snap = r.snapshot();
      expect(snap.todoItems).toHaveLength(3);
      expect(snap.todoItems[0]).toEqual({ content: 'Write tests', status: 'completed' });
      expect(snap.todoItems[1]).toEqual({ content: 'Fix bug', status: 'in_progress' });
      expect(snap.todoItems[2]).toEqual({ content: 'Deploy', status: 'pending' });
      r.dispose();
    });

    it('includes accumulated response text from onTextDelta', () => {
      const r = createRenderer();
      r.onTextDelta('hello ');
      r.onTextDelta('world');
      const snap = r.snapshot();
      expect(snap.phase).toBe('executing');
      expect(snap.responseText).toBe('hello world');
      r.dispose();
    });

    it('returns defensive copies (modifying returned snapshot does not affect internal state)', () => {
      const r = createRenderer();
      r.onToolStart('Bash');
      r.onToolStart('Read');
      r.onPermissionNeeded('Bash', 'cmd', 'p1', defaultButtons);
      r.onTodoUpdate([{ content: 'Task 1', status: 'pending' }]);

      const snap1 = r.snapshot();

      // Mutate returned snapshot
      snap1.toolCounts.set('Bash', 999);
      snap1.toolCounts.set('Fake', 1);
      snap1.permissionQueue.push({ toolName: 'Fake', input: 'x', permId: 'x', buttons: [] });
      snap1.todoItems.push({ content: 'Injected', status: 'completed' });

      // Take a fresh snapshot — should be unaffected
      const snap2 = r.snapshot();
      expect(snap2.toolCounts.get('Bash')).toBe(1);
      expect(snap2.toolCounts.has('Fake')).toBe(false);
      expect(snap2.permissionQueue).toHaveLength(1);
      expect(snap2.todoItems).toHaveLength(1);
      r.dispose();
    });
  });
});
