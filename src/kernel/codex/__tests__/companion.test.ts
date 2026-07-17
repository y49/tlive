import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startCompanion, threadKey } from '../companion';

function harness() {
  const calls: any[] = [];
  let events: any; // captured CodexRpcEvents wiring via deps.connect
  const rpc = {
    call: vi.fn(async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return { data: ['t1'] };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      return {};
    }),
    notify: vi.fn(),
    close: vi.fn(),
  };
  const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
  const onMonitor = vi.fn();
  const comp = startCompanion({
    connect: async (e: any) => { events = e; return rpc as any; },
    permissionRouter: router as any,
    onMonitor,
    onResumePrompt: vi.fn(),
    windowSec: () => 86_400,
  });
  return { rpc, router, onMonitor, comp, calls, getEvents: () => events, setEvents: (e: any) => { events = e; } };
}

describe('companion', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('on connect lists and resumes threads', async () => {
    const { calls, comp } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.some((c) => c.method === 'thread/loaded/list')).toBe(true);
    expect(calls.some((c) => c.method === 'thread/resume' && c.params.threadId === 't1')).toBe(true);
    comp.stop();
  });

  it('resume retries on no-rollout then succeeds', async () => {
    const calls: any[] = [];
    let events: any;
    let resumeAttempts = 0;
    const rpc = {
      call: vi.fn(async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'thread/loaded/list') return { data: ['t1'] };
        if (method === 'thread/resume') {
          resumeAttempts++;
          if (resumeAttempts < 3) throw new Error('no rollout found for thread t1');
          return { thread: { id: params.threadId } };
        }
        return {};
      }),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor: vi.fn(),
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resumeAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(resumeAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(resumeAttempts).toBe(3);
    comp.stop();
  });

  it('approval ServerRequest -> requestPermission -> accept response', async () => {
    const { comp, router, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();
    const respond = vi.fn();
    events.onServerRequest(5, 'item/commandExecution/requestApproval', { threadId: 't1', itemId: 'i1', command: 'rm -rf /', cwd: '/w' }, respond);
    await Promise.resolve();
    await Promise.resolve();
    expect(router.requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      // This harness's thread/resume mock never returns a `cwd`, so the
      // session cwd falls back to the thread key (see cwdOf in companion.ts).
      // The payload's own `/w` (command-execution cwd) stays confined to
      // `input.cwd` below — it is never promoted to the session cwd.
      key: 'codex:t1',
      cwd: 'codex:t1',
      toolName: 'Bash',
      timeoutSec: 86_400,
      sessionId: 't1',
      input: expect.objectContaining({ command: 'rm -rf /', cwd: '/w' }),
    }));
    expect(respond).toHaveBeenCalledWith({ decision: 'accept' });
    comp.stop();
  });

  it('deny maps to decline; defer never responds', async () => {
    const { comp, router, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();

    router.requestPermission.mockResolvedValueOnce({ decision: 'deny' });
    const respondDeny = vi.fn();
    events.onServerRequest(6, 'item/commandExecution/requestApproval', { threadId: 't1', itemId: 'i2', command: 'echo hi' }, respondDeny);
    await Promise.resolve();
    await Promise.resolve();
    expect(respondDeny).toHaveBeenCalledWith({ decision: 'decline' });

    router.requestPermission.mockResolvedValueOnce({ decision: 'defer' });
    const respondDefer = vi.fn();
    events.onServerRequest(7, 'item/commandExecution/requestApproval', { threadId: 't1', itemId: 'i3', command: 'echo bye' }, respondDefer);
    await Promise.resolve();
    await Promise.resolve();
    expect(respondDefer).not.toHaveBeenCalled();
    comp.stop();
  });

  it('item/completed(commandExecution) and turn/completed trigger cancel with threadKey', async () => {
    const { comp, router, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();

    events.onNotify('item/completed', { threadId: 't1', item: { type: 'commandExecution' } });
    expect(router.cancel).toHaveBeenCalledWith({ key: 'codex:t1', toolName: 'Bash', sessionId: 't1' });

    events.onNotify('turn/completed', { threadId: 't1' });
    expect(router.cancel).toHaveBeenCalledWith({ key: 'codex:t1' });
    comp.stop();
  });

  it('reconnects after onClose with backoff and stop() ends the loop', async () => {
    let connectCount = 0;
    let events: any;
    const rpc = {
      call: vi.fn(async (method: string) => (method === 'thread/loaded/list' ? { data: [] } : {})),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const comp = startCompanion({
      connect: async (e: any) => { connectCount++; events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor: vi.fn(),
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(connectCount).toBe(1);

    events.onClose();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(connectCount).toBe(2);

    events.onClose();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();
    expect(connectCount).toBe(3);

    comp.stop();
    events.onClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connectCount).toBe(3);
  });

  it('item/started userMessage -> prompt monitor event', async () => {
    const { comp, onMonitor, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();
    events.onNotify('item/started', { threadId: 't1', item: { type: 'userMessage', content: [{ text: 'hello' }] } });
    expect(onMonitor).toHaveBeenCalledWith({ event: 'prompt', cwd: 'codex:t1', sessionId: 't1', prompt: 'hello' }, 'codex:t1');
    comp.stop();
  });

  it('item/started commandExecution -> activity monitor event', async () => {
    const { comp, onMonitor, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();
    events.onNotify('item/started', { threadId: 't1', item: { type: 'commandExecution' } });
    expect(onMonitor).toHaveBeenCalledWith({ event: 'activity', cwd: 'codex:t1', sessionId: 't1', toolName: 'Bash', result: {} }, 'codex:t1');
    comp.stop();
  });

  it('turn/started -> (turn) activity monitor event', async () => {
    const { comp, onMonitor, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();
    events.onNotify('turn/started', { threadId: 't1' });
    expect(onMonitor).toHaveBeenCalledWith({ event: 'activity', cwd: 'codex:t1', sessionId: 't1', toolName: '(turn)', result: {} }, 'codex:t1');
    comp.stop();
  });

  it('turn/completed -> attention with remembered lastMessage + onResumePrompt', async () => {
    const calls: any[] = [];
    let events: any;
    const rpc = {
      call: vi.fn(async (method: string) => (method === 'thread/loaded/list' ? { data: ['t1'] } : {})),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const onMonitor = vi.fn();
    const onResumePrompt = vi.fn();
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor,
      onResumePrompt,
      windowSec: () => 86_400,
    });
    calls.length = 0;
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    events.onNotify('item/completed', { threadId: 't1', item: { type: 'agentMessage', text: 'final answer' } });
    events.onNotify('turn/completed', { threadId: 't1' });

    expect(onMonitor).toHaveBeenCalledWith(
      { event: 'attention', cwd: 'codex:t1', sessionId: 't1', message: 'Turn finished — reply to continue', lastMessage: 'final answer' },
      'codex:t1',
    );
    expect(onResumePrompt).toHaveBeenCalledWith({ threadId: 't1', key: 'codex:t1', lastMessage: 'final answer' });
    comp.stop();
  });

  it('thread/archived -> session-end monitor event', async () => {
    // Real archival notification: ThreadArchivedNotification { threadId }
    // (app-server-protocol .../v2/common.rs:1323-1328, camelCase on the wire),
    // delivered as method "thread/archived" (common.rs:1485). This is a
    // *separate* notification from thread/status/changed — see the next test.
    const { comp, onMonitor, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();
    events.onNotify('thread/archived', { threadId: 't1' });
    expect(onMonitor).toHaveBeenCalledWith({ event: 'session-end', cwd: 'codex:t1', sessionId: 't1' }, 'codex:t1');
    comp.stop();
  });

  it('thread/status/changed (any real ThreadStatus shape) never fires session-end', async () => {
    // ThreadStatus (app-server-protocol .../v2/thread.rs:1131-1144) has exactly
    // four variants — notLoaded / idle / systemError / active — with #[serde(tag
    // = "type")]. There is no `archived` variant, so this notification can never
    // carry archival; session-end must come only from thread/archived (above).
    const { comp, onMonitor, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();
    events.onNotify('thread/status/changed', { threadId: 't1', status: { type: 'notLoaded' } });
    events.onNotify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    events.onNotify('thread/status/changed', { threadId: 't1', status: { type: 'systemError' } });
    events.onNotify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } });
    expect(onMonitor).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'session-end' }), expect.anything());
    comp.stop();
  });

  it('resume() calls turn/start with items array', async () => {
    const { comp, calls } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    await comp.resume('t1', 'fix tests');
    expect(calls.some((c) => c.method === 'turn/start' && c.params.threadId === 't1'
      && Array.isArray(c.params.input) && c.params.input[0].text === 'fix tests')).toBe(true);
    comp.stop();
  });

  it('resume() throws when not connected', async () => {
    const { comp, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    getEvents().onClose();
    await expect(comp.resume('t1', 'x')).rejects.toThrow();
    comp.stop();
  });

  it('polls thread/loaded/list periodically and resumes newly appearing threads', async () => {
    let listResult: { data: string[] } = { data: [] };
    const calls: any[] = [];
    let events: any;
    const rpc = {
      call: vi.fn(async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'thread/loaded/list') return listResult;
        if (method === 'thread/resume') return { thread: { id: params.threadId } };
        return {};
      }),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor: vi.fn(),
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((c) => c.method === 'thread/resume').length).toBe(0);

    listResult = { data: ['t9'] };
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((c) => c.method === 'thread/resume' && c.params.threadId === 't9').length).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((c) => c.method === 'thread/resume' && c.params.threadId === 't9').length).toBe(1);

    comp.stop();
  });

  it('clears resumed set and polling on close; re-resumes after reconnect', async () => {
    let connectCount = 0;
    let events: any;
    const rpc = {
      call: vi.fn(async (method: string) => (method === 'thread/loaded/list' ? { data: ['t1'] } : {})),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const comp = startCompanion({
      connect: async (e: any) => { connectCount++; events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor: vi.fn(),
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    expect(connectCount).toBe(1);
    expect(rpc.call.mock.calls.filter((c) => c[0] === 'thread/resume' && c[1].threadId === 't1').length).toBe(1);

    events.onClose();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(connectCount).toBe(2);
    expect(rpc.call.mock.calls.filter((c) => c[0] === 'thread/resume' && c[1].threadId === 't1').length).toBe(2);

    comp.stop();
  });

  it('threadKey formats id', () => {
    expect(threadKey('abc')).toBe('codex:abc');
  });

  it('requestPermission rejection does not crash; logs, never responds, leaves pending', async () => {
    const { comp, router, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();

    const rejectionError = new Error('approval request failed');
    router.requestPermission.mockRejectedValueOnce(rejectionError);
    const respond = vi.fn();
    events.onServerRequest(8, 'item/commandExecution/requestApproval', { threadId: 't1', itemId: 'i4', command: 'dangerous cmd' }, respond);

    // Drain microtasks and wait a tick
    await Promise.resolve();
    await Promise.resolve();

    // respond should never be called (approval stays pending)
    expect(respond).not.toHaveBeenCalled();

    comp.stop();
  });

  it('a thread whose resume retries exhaust is retried again on a later poll', async () => {
    const calls: any[] = [];
    let events: any;
    let resumeAttempts = 0;
    let shouldSucceed = false;
    const rpc = {
      call: vi.fn(async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'thread/loaded/list') return { data: ['t2'] };
        if (method === 'thread/resume') {
          resumeAttempts++;
          // Fail with 'no rollout' for first 10 attempts (RESUME_RETRY_MAX),
          // then succeed on attempt 11 (after poll triggers fresh retry)
          if (!shouldSucceed) throw new Error('no rollout found for thread t2');
          return { thread: { id: params.threadId } };
        }
        return {};
      }),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor: vi.fn(),
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await Promise.resolve();
    await Promise.resolve();

    // Initial connect + poll should trigger first resume attempt
    expect(resumeAttempts).toBe(1);

    // Exhaust all RESUME_RETRY_MAX (10) retries: each at 3000ms intervals
    // Attempts 2-10 (9 retries after initial)
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(resumeAttempts).toBe(10);

    // Now allow resume to succeed
    shouldSucceed = true;

    // Advance to the next poll cycle (at 30s: initial poll at 0s, then 15s, 30s, 45s, ...)
    // This poll will call resumeThread again since we deleted from resumed set on final failure
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.resolve();
    await Promise.resolve();
    // At time 30s, poll should trigger and make attempt 11
    expect(resumeAttempts).toBe(11);

    comp.stop();
  });

  it('reports the real cwd (from thread/resume) so the session label becomes the project name', async () => {
    let events: any;
    const rpc = {
      call: vi.fn(async (method: string, params: any) => {
        if (method === 'thread/loaded/list') return { data: ['t1'] };
        if (method === 'thread/resume') return { thread: { id: params.threadId }, cwd: '/home/y/Project/mihomo-gui' };
        return {};
      }),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const onMonitor = vi.fn();
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor,
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    events.onNotify('item/started', { threadId: 't1', item: { type: 'userMessage', content: [{ text: 'hi' }] } });
    // key stays the unique thread id; cwd becomes the real directory so
    // registry's label = basename(cwd) = "mihomo-gui" instead of "codex:t1".
    expect(onMonitor).toHaveBeenCalledWith(
      { event: 'prompt', cwd: '/home/y/Project/mihomo-gui', sessionId: 't1', prompt: 'hi' },
      'codex:t1',
    );
    comp.stop();
  });

  it('falls back to the thread key when resume yields no cwd (never crashes)', async () => {
    // harness()'s thread/resume mock returns no `cwd` — this documents the
    // fallback explicitly, as the safety net for Step 3's cwdOf().
    const { comp, onMonitor, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const events = getEvents();
    events.onNotify('item/started', { threadId: 't1', item: { type: 'userMessage', content: [{ text: 'hi' }] } });
    expect(onMonitor).toHaveBeenCalledWith(
      { event: 'prompt', cwd: 'codex:t1', sessionId: 't1', prompt: 'hi' },
      'codex:t1',
    );
    comp.stop();
  });

  it('requestPermission gets the real session cwd while input.cwd keeps the command-execution cwd and key stays codex:<id>', async () => {
    let events: any;
    const rpc = {
      call: vi.fn(async (method: string, params: any) => {
        if (method === 'thread/loaded/list') return { data: ['t1'] };
        if (method === 'thread/resume') return { thread: { id: params.threadId }, cwd: '/home/y/Project/mihomo-gui' };
        return {};
      }),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor: vi.fn(),
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    const respond = vi.fn();
    events.onServerRequest(5, 'item/commandExecution/requestApproval', { threadId: 't1', itemId: 'i1', command: 'rm -rf /', cwd: '/w' }, respond);
    await Promise.resolve();
    await Promise.resolve();

    expect(router.requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      key: 'codex:t1',
      cwd: '/home/y/Project/mihomo-gui', // session cwd, from thread/resume — NOT the payload's '/w'
      input: expect.objectContaining({ command: 'rm -rf /', cwd: '/w' }), // command-execution cwd, untouched
    }));
    comp.stop();
  });

  it('clears the cached cwd on thread/archived, so a stray later event for the same id falls back instead of leaking a stale value', async () => {
    let events: any;
    const rpc = {
      call: vi.fn(async (method: string, params: any) => {
        if (method === 'thread/loaded/list') return { data: ['t1'] };
        if (method === 'thread/resume') return { thread: { id: params.threadId }, cwd: '/home/y/Project/demo' };
        return {};
      }),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
    const onMonitor = vi.fn();
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor,
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    events.onNotify('item/started', { threadId: 't1', item: { type: 'userMessage', content: [{ text: 'hi' }] } });
    expect(onMonitor).toHaveBeenLastCalledWith(
      { event: 'prompt', cwd: '/home/y/Project/demo', sessionId: 't1', prompt: 'hi' },
      'codex:t1',
    );

    events.onNotify('thread/archived', { threadId: 't1' });

    // A stray notification for the same (now-archived) threadId must not
    // resurrect the stale cached cwd — the map entry must be gone.
    events.onNotify('item/started', { threadId: 't1', item: { type: 'userMessage', content: [{ text: 'again' }] } });
    expect(onMonitor).toHaveBeenLastCalledWith(
      { event: 'prompt', cwd: 'codex:t1', sessionId: 't1', prompt: 'again' },
      'codex:t1',
    );

    comp.stop();
  });
});
