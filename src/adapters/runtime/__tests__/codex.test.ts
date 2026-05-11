import { describe, it, expect, vi } from 'vitest';
import { CodexRuntimeAdapter } from '../codex';

// Mock the codex transport — we don't actually spawn `codex app-server`.
vi.mock('../codex-transport', () => ({
  spawnCodexAppServer: vi.fn(async () => ({
    request: vi.fn(async (method: string, _params: unknown) => {
      if (method === 'thread/start') return { threadId: 'codex-thread-1' };
      if (method === 'thread/resume') return { threadId: 'codex-thread-1' };
      return {};
    }),
    onNotification: vi.fn(),
    close: vi.fn(),
  })),
}));

describe('CodexRuntimeAdapter', () => {
  it('start returns providerSessionId from thread/start', async () => {
    const a = new CodexRuntimeAdapter();
    const out = await a.start({ workspaceDir: '/tmp/foo' });
    expect(out.providerSessionId).toBe('codex-thread-1');
  });

  it('resume passes resumeProviderSessionId to thread/resume', async () => {
    const a = new CodexRuntimeAdapter();
    const out = await a.start({ workspaceDir: '/tmp/foo', resumeProviderSessionId: 'old-thread' });
    expect(out.providerSessionId).toBe('codex-thread-1');
  });
});
