import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexAppServerProvider, __testing_resetBinaryDetectCache } from '../index.js';

describe('CodexAppServerProvider — binary detection + lifecycle', () => {
  beforeEach(() => {
    __testing_resetBinaryDetectCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isAvailable() returns false when codex binary not in PATH', async () => {
    const provider = new CodexAppServerProvider({
      execFile: vi.fn().mockRejectedValue(new Error('spawn ENOENT')),
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  it('isAvailable() returns false when codex version < 0.121.0', async () => {
    const provider = new CodexAppServerProvider({
      execFile: vi.fn().mockResolvedValue({ stdout: 'codex-cli 0.120.0\n', stderr: '' }),
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  it('isAvailable() returns true when codex version >= 0.121.0', async () => {
    const provider = new CodexAppServerProvider({
      execFile: vi.fn().mockResolvedValue({ stdout: 'codex-cli 0.121.5\n', stderr: '' }),
    });
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable() result is cached after first call', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: 'codex-cli 0.121.0\n', stderr: '' });
    const provider = new CodexAppServerProvider({ execFile });
    await provider.isAvailable();
    await provider.isAvailable();
    await provider.isAvailable();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('capabilities() returns provider capabilities for codex flavor', () => {
    const provider = new CodexAppServerProvider({ execFile: vi.fn() });
    const caps = provider.capabilities();
    expect(caps).toBeDefined();
    expect(typeof caps).toBe('object');
  });
});
