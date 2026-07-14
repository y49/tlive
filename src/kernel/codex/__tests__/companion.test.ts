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

  it('threadKey formats id', () => {
    expect(threadKey('abc')).toBe('codex:abc');
  });
});
