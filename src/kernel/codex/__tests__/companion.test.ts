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
  const onResumePrompt = vi.fn();
  const comp = startCompanion({
    connect: async (e: any) => { events = e; return rpc as any; },
    permissionRouter: router as any,
    onMonitor,
    onResumePrompt,
    windowSec: () => 86_400,
  });
  return { rpc, router, onMonitor, onResumePrompt, comp, calls, getEvents: () => events, setEvents: (e: any) => { events = e; } };
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
    expect(onResumePrompt).toHaveBeenCalledWith({ threadId: 't1', key: 'codex:t1', lastMessage: 'final answer', outcome: 'completed' });

    // An empty agentMessage must not clobber the real last message — the
    // continue card's excerpt would collapse to a bare "Reply to continue".
    events.onNotify('item/completed', { threadId: 't1', item: { type: 'agentMessage', text: '' } });
    events.onNotify('turn/completed', { threadId: 't1' });
    expect(onResumePrompt).toHaveBeenLastCalledWith({ threadId: 't1', key: 'codex:t1', lastMessage: 'final answer', outcome: 'completed' });
    comp.stop();
  });

  describe('failed turns are reported, not announced as finished', () => {
    async function live() {
      const h = harness();
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      return { ...h, events: h.getEvents(), lastResume: () => h.onResumePrompt.mock.lastCall![0] as any };
    }

    it('turn/completed status=failed carries turn.error.message', async () => {
      const { events, onMonitor, comp } = await live();
      events.onNotify('turn/completed', {
        threadId: 't1',
        turn: { status: 'failed', error: { message: '401 Unauthorized: Invalid API key' } },
      });
      expect(onMonitor).toHaveBeenLastCalledWith(
        { event: 'attention', cwd: 'codex:t1', sessionId: 't1', message: 'Codex turn failed: 401 Unauthorized: Invalid API key' },
        'codex:t1',
      );
      comp.stop();
    });

    it('an aborted turn preceded by a non-retryable error is a failure, not an interrupt', async () => {
      // This is the 401 shape. Codex reports auth failure as an ABORT
      // (bespoke_event_handling.rs:1497 handle_turn_interrupted → status
      // interrupted, error None), so the message only ever arrives on the
      // separate `error` notification. Trusting `status` alone reports the
      // user's own Esc and a dead API key identically.
      const { events, comp, lastResume } = await live();
      events.onNotify('error', {
        threadId: 't1', turnId: 'u1', willRetry: false,
        error: { message: 'unexpected status 401 Unauthorized' },
      });
      events.onNotify('turn/completed', { threadId: 't1', turn: { status: 'interrupted', error: null } });
      expect(lastResume()).toMatchObject({ outcome: 'failed', errorMessage: 'unexpected status 401 Unauthorized' });
      comp.stop();
    });

    it('willRetry errors are transient noise and never surface', async () => {
      // StreamError (bespoke_event_handling.rs:937) fires per retry — the 401
      // websocket spam was 17 of these in 60 seconds. Reporting them would be
      // the empty-card flood again with a different payload.
      const { events, comp, lastResume } = await live();
      events.onNotify('error', { threadId: 't1', turnId: 'u1', willRetry: true, error: { message: 'transient' } });
      events.onNotify('turn/completed', { threadId: 't1', turn: { status: 'interrupted', error: null } });
      expect(lastResume()).toMatchObject({ outcome: 'interrupted' });
      expect(lastResume().errorMessage).toBeUndefined();
      comp.stop();
    });

    it('a bare interrupt stays an interrupt — you pressed Esc, you already know', async () => {
      const { events, comp, lastResume } = await live();
      events.onNotify('turn/completed', { threadId: 't1', turn: { status: 'interrupted', error: null } });
      expect(lastResume()).toMatchObject({ outcome: 'interrupted' });
      comp.stop();
    });

    it('a recorded error does not leak into the next turn', async () => {
      const { events, comp, lastResume } = await live();
      events.onNotify('error', { threadId: 't1', turnId: 'u1', willRetry: false, error: { message: 'old failure' } });
      events.onNotify('turn/completed', { threadId: 't1', turn: { status: 'failed', error: null } });
      expect(lastResume()).toMatchObject({ outcome: 'failed', errorMessage: 'old failure' });
      events.onNotify('turn/started', { threadId: 't1' });
      events.onNotify('turn/completed', { threadId: 't1', turn: { status: 'interrupted', error: null } });
      expect(lastResume()).toMatchObject({ outcome: 'interrupted' });
      expect(lastResume().errorMessage).toBeUndefined();
      comp.stop();
    });

    it('an app-server that sends no turn payload is treated as a normal completion', async () => {
      const { events, comp, lastResume } = await live();
      events.onNotify('turn/completed', { threadId: 't1' });
      expect(lastResume()).toMatchObject({ outcome: 'completed' });
      comp.stop();
    });
  });

  describe('subscription lifetime', () => {
    /** A thread we subscribe to is one the app-server cannot unload, and an
     *  unloadable thread is one whose pending approvals are never cancelled.
     *  These tests pin the two halves that make releasing safe. */
    function rig(opts: { loaded: string[]; read?: (id: string) => any } = { loaded: ['t1'] }) {
      const calls: Array<{ method: string; params: any }> = [];
      let events: any;
      const rpc = {
        call: vi.fn(async (method: string, params: any) => {
          calls.push({ method, params });
          if (method === 'thread/loaded/list') return { data: opts.loaded };
          if (method === 'thread/read') return { thread: opts.read?.(params.threadId) ?? { updatedAt: 100, status: { type: 'idle' } } };
          return {};
        }),
        notify: vi.fn(), close: vi.fn(),
      };
      const comp = startCompanion({
        connect: async (e: any) => { events = e; return rpc as any; },
        permissionRouter: { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) } as any,
        onMonitor: vi.fn(), onResumePrompt: vi.fn(), windowSec: () => 86_400,
      });
      const since = (m: string) => calls.filter((c) => c.method === m);
      return { comp, calls, since, getEvents: () => events };
    }

    it('releases a thread that has been silent long enough to be dead', async () => {
      const { comp, since } = rig();
      await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
      expect(since('thread/resume')).toHaveLength(1);
      expect(since('thread/unsubscribe')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(since('thread/unsubscribe').at(-1)?.params).toEqual({ threadId: 't1' });
      comp.stop();
    });

    it('activity keeps a live thread subscribed indefinitely', async () => {
      const { comp, since, getEvents } = rig();
      await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        getEvents().onNotify('turn/started', { threadId: 't1' });
      }
      expect(since('thread/unsubscribe')).toHaveLength(0);
      comp.stop();
    });

    it('a released thread is not re-subscribed while it stays quiet', async () => {
      // Without this the poll would re-resume it seconds later and the pair
      // would flap forever, re-arming the very subscription that keeps the
      // thread loaded.
      const { comp, since } = rig();
      await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      const resumesAtRelease = since('thread/resume').length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(since('thread/resume')).toHaveLength(resumesAtRelease);
      expect(since('thread/read').length).toBeGreaterThan(0); // watched, not subscribed
      comp.stop();
    });

    it('a released thread is re-subscribed as soon as it shows life', async () => {
      let updatedAt = 100;
      const { comp, since } = rig({ loaded: ['t1'], read: () => ({ updatedAt, status: { type: 'idle' } }) });
      await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      const before = since('thread/resume').length;
      updatedAt = 200; // the user typed into that TUI again
      await vi.advanceTimersByTimeAsync(6000);
      expect(since('thread/resume').length).toBe(before + 1);
      comp.stop();
    });

    it('an active status counts as life even when updatedAt has not moved', async () => {
      let status: any = { type: 'idle' };
      const { comp, since } = rig({ loaded: ['t1'], read: () => ({ updatedAt: 100, status }) });
      await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      const before = since('thread/resume').length;
      status = { type: 'active', activeFlags: ['waitingOnApproval'] };
      await vi.advanceTimersByTimeAsync(6000);
      expect(since('thread/resume').length).toBe(before + 1);
      comp.stop();
    });
  });

  it('thread/closed ends the session and releases what it was still holding', async () => {
    // The app-server sends this once a thread has no subscribers and shuts
    // down — and it cancels that thread's pending requests on the way out,
    // saying plainly that they "can no longer be answered". Ignoring it left a
    // card offering a decision nothing would ever receive.
    const { comp, router, onMonitor, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
    getEvents().onNotify('thread/closed', { threadId: 't1' });
    expect(onMonitor).toHaveBeenCalledWith({ event: 'session-end', cwd: 'codex:t1', sessionId: 't1' }, 'codex:t1');
    expect(router.cancel).toHaveBeenCalledWith({ key: 'codex:t1' });
    comp.stop();
  });

  it('serverRequest/resolved withdraws a card someone else answered', async () => {
    // First-class version of what was inferred from item/completed: the
    // app-server says outright that this request is settled.
    const { comp, router, getEvents } = harness();
    await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
    getEvents().onNotify('serverRequest/resolved', { threadId: 't1', requestId: 7 });
    expect(router.cancel).toHaveBeenCalledWith({ key: 'codex:t1' });
    comp.stop();
  });

  describe('approval posture', () => {
    function rig(policy: 'ignore' | 'notify' | 'hold') {
      let events: any;
      const rpc = {
        call: vi.fn(async (m: string) => (m === 'thread/loaded/list' ? { data: ['t1'] } : {})),
        notify: vi.fn(), close: vi.fn(),
      };
      const router = { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) };
      const onNativePrompt = vi.fn();
      const onNativePromptResolved = vi.fn();
      const comp = startCompanion({
        connect: async (e: any) => { events = e; return rpc as any; },
        permissionRouter: router as any,
        onMonitor: vi.fn(),
        onResumePrompt: vi.fn(),
        windowSec: () => 86_400,
        approvalPolicy: () => policy,
        onNativePrompt,
        onNativePromptResolved,
      });
      return { comp, router, onNativePrompt, onNativePromptResolved, getEvents: () => events };
    }

    it('off: behaves as if tlive were not installed — no card, no signal, no answer', async () => {
      // `off` is documented as a kill switch. It was not one for Codex: the
      // companion answered app-server approvals in every posture, because the
      // ladder was only ever consulted by the Claude Code shim.
      const { comp, router, onNativePrompt, getEvents } = rig('ignore');
      await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
      const respond = vi.fn();
      getEvents().onServerRequest(1, 'item/commandExecution/requestApproval', { threadId: 't1', command: 'rm -rf /' }, respond);
      await Promise.resolve(); await Promise.resolve();
      expect(router.requestPermission).not.toHaveBeenCalled();
      expect(onNativePrompt).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();  // never answered: the native prompt owns it
      comp.stop();
    });

    it('notify: points at the terminal without holding or answering', async () => {
      // Same rule the Claude Code path follows in this posture — the machine is
      // told a prompt is waiting, IM is not, and nothing is held. Codex can say
      // more than Claude Code does here: the request carries the real command,
      // where CC's Notification carries no tool name at all.
      const { comp, router, onNativePrompt, onNativePromptResolved, getEvents } = rig('notify');
      await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
      const respond = vi.fn();
      getEvents().onServerRequest(1, 'item/commandExecution/requestApproval', { threadId: 't1', command: 'rm -rf /', reason: 'because' }, respond);
      await Promise.resolve(); await Promise.resolve();
      expect(router.requestPermission).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      expect(onNativePrompt).toHaveBeenCalledWith(expect.objectContaining({ key: 'codex:t1', detail: expect.stringContaining('rm -rf /') }));
      // …and it retires when the command runs, so the dashboard card cannot strand.
      getEvents().onNotify('item/completed', { threadId: 't1', item: { type: 'commandExecution' } });
      expect(onNativePromptResolved).toHaveBeenCalledWith({ key: 'codex:t1' });
      comp.stop();
    });

    it('hold: the full posture still holds and answers', async () => {
      const { comp, router, getEvents } = rig('hold');
      await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); await Promise.resolve();
      const respond = vi.fn();
      getEvents().onServerRequest(1, 'item/commandExecution/requestApproval', { threadId: 't1', command: 'ls' }, respond);
      await Promise.resolve(); await Promise.resolve();
      expect(router.requestPermission).toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith({ decision: 'accept' });
      comp.stop();
    });
  });

  it('a dropped connection abandons its pending approvals', async () => {
    // The approval's caller IS the app-server connection. When it dies the
    // request dies with it, but the card outlived it by the whole approval
    // window - up to 24h of a surface offering a decision that would now be
    // written to a closed socket. Claude Code's side already does this: the IPC
    // server hands requestPermission an onAbandoned tied to that connection.
    let events: any;
    let resolved: unknown;
    const rpc = {
      call: vi.fn(async (method: string) => (method === 'thread/loaded/list' ? { data: ['t1'] } : {})),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const router = {
      requestPermission: vi.fn((opts: any) =>
        new Promise((resolve) => { opts.onAbandoned?.(() => resolve({ decision: 'gone' })); })
          .then((r) => { resolved = r; return r; })),
      cancel: vi.fn(() => 0),
    };
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: router as any,
      onMonitor: vi.fn(),
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve(); await Promise.resolve();

    const respond = vi.fn();
    events.onServerRequest(9, 'item/commandExecution/requestApproval', { threadId: 't1', command: 'rm -rf /' }, respond);
    await Promise.resolve(); await Promise.resolve();
    expect(resolved).toBeUndefined();     // still waiting for an answer

    events.onClose();                     // the app-server died
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(resolved).toEqual({ decision: 'gone' });
    expect(respond).not.toHaveBeenCalled(); // nothing is written to a dead socket
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
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((c) => c.method === 'thread/resume' && c.params.threadId === 't9').length).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
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

    // Advance to the next poll cycle (polls run every 5s; retries ended at 27s, next poll at 30s)
    // This poll will call resumeThread again since we deleted from resumed set on final failure
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.resolve();
    await Promise.resolve();
    // At time 30s, poll should trigger and make attempt 11
    expect(resumeAttempts).toBe(11);

    comp.stop();
  });

  // Ground truth: codex-rs/app-server-protocol/src/protocol/common.rs:1349,
  //   ToolRequestUserInput => "item/tool/requestUserInput"
  // in `server_request_definitions!`. tlive matched the bare
  // "tool/requestUserInput", so the branch was dead: Codex asking a question in
  // the terminal reached no surface at all. Same failure as the Claude Code
  // `error_type`/`tool_error` field names — a wire name written from memory
  // instead of read off the other side — and no test named the string either.
  it('a Codex question in the terminal reaches the monitor surfaces', async () => {
    const { getEvents, onMonitor, comp } = harness();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve(); await Promise.resolve();
    getEvents().onServerRequest(9, 'item/tool/requestUserInput', { threadId: 't1', itemId: 'i9' }, vi.fn());
    await Promise.resolve(); await Promise.resolve();
    expect(onMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attention', sessionId: 't1' }),
      threadKey('t1'),
    );
    comp.stop();
  });

  // The retry above is deliberate — a rollout can show up late — but the LOG
  // must not repeat with it. A thread whose rollout is gone for good keeps
  // failing every poll cycle forever, and one line per cycle is how this
  // machine's daemon.log collected 62 identical lines for a single dead thread.
  // Once per thread per connection: a reconnect is new information, another
  // sweep of the same dead thread is not.
  it('a permanently unresumable thread is reported once, not once per poll cycle', async () => {
    let events: any;
    const logged: string[] = [];
    const rpc = {
      call: vi.fn(async (method: string, params: any) => {
        if (method === 'thread/loaded/list') return { data: ['t9'] };
        if (method === 'thread/resume') throw new Error('no rollout found for thread id t9');
        return {};
      }),
      notify: vi.fn(),
      close: vi.fn(),
    };
    const comp = startCompanion({
      connect: async (e: any) => { events = e; return rpc as any; },
      permissionRouter: { requestPermission: vi.fn(async () => ({ decision: 'allow' })), cancel: vi.fn(() => 0) } as any,
      onMonitor: vi.fn(),
      onResumePrompt: vi.fn(),
      windowSec: () => 86_400,
      log: (m) => { if (/resume .* failed/.test(m)) logged.push(m); },
    });
    await Promise.resolve(); await Promise.resolve();
    // Well past two full retry-exhaustion cycles (10 attempts x 3s = 27s each).
    for (let i = 0; i < 40; i++) { await vi.advanceTimersByTimeAsync(3000); await Promise.resolve(); await Promise.resolve(); }
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('t9');
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
