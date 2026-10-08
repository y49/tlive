import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../hook.js';

const { request, loadConfig } = vi.hoisted(() => ({
  request: vi.fn(),
  loadConfig: vi.fn(),
}));
vi.mock('../../../kernel/ipc/client.js', () => ({ request }));
vi.mock('../../../kernel/config/loader.js', () => ({ loadConfig }));

describe('Stop hooks after a remotely resumed turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({ mode: 'all', approvals: { continueWindowSec: 30 } });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.stubEnv('TLIVE_SESSION', '');
    vi.stubEnv('TLIVE_HOME', '/unused-tlive-test-home');
  });
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function stopInput(active: boolean) {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(JSON.stringify({
        cwd: '/project', session_id: 'session-1', stop_hook_active: active,
        last_assistant_message: 'The requested task is complete.',
      }));
    });
  }

  it.each([false, true])('reports completion with stop_hook_active=%s without waking an unanswered turn', async (active) => {
    stopInput(active);
    request.mockResolvedValue({ kind: 'hook.continue.result', reply: null });
    await runHook(['stop']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hook.continue.request', cwd: '/project', sessionId: 'session-1',
      lastMessage: 'The requested task is complete.',
    }), { timeoutMs: 40_000 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(2);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('resumes a remotely resumed turn only when a new reply arrives', async () => {
    stopInput(true);
    request.mockResolvedValue({ kind: 'hook.continue.result', reply: 'Run the next check.' });
    await runHook(['stop']);
    expect(process.stderr.write).toHaveBeenCalledWith('Run the next check.');
    expect(process.exitCode).toBe(2);
  });

  it('does not wake the session when the daemon is unavailable', async () => {
    stopInput(true);
    request.mockRejectedValue(new Error('daemon unavailable'));
    await runHook(['stop']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(2);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('still skips all notification and continuation work in off mode', async () => {
    loadConfig.mockReturnValue({ mode: 'off' });
    await runHook(['stop']);
    expect(request).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(2);
  });
});
