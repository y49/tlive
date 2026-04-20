import { describe, it, expect, vi } from 'vitest';
import { TLiveLoop } from '../src/loop.js';
import { ScannerContext } from '../src/core/scannerContext.js';
import type { ProviderAdapter, NormalizedMessage } from '../src/sdk/providerAdapter.js';
import type { TLiveConfig } from '../src/config.js';

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return { ...actual, homedir: () => '/tmp/tlive-loop-test' };
});

function mockAdapter(): ProviderAdapter {
  return {
    name: 'mock',
    resolveExecutable: vi.fn().mockResolvedValue('/bin/sh'),
    getSessionIdArgs: vi.fn((sid) => ['--session-id', sid]),
    getResumeArgs: vi.fn((sid) => ['--resume', '--session-id', sid]),
    spawnArgs: vi.fn(() => ['-c', 'echo loop-test']),
    startRemote: vi.fn(async function* (): AsyncIterable<NormalizedMessage> {
      yield { kind: 'complete', provider: 'claude', sessionId: 'test' };
    }),
    getSessionDir: vi.fn(() => '/tmp/sessions'),
    toEvents: vi.fn(() => []),
    toPermissionEvent: vi.fn(() => ({
      kind: 'permission_request', toolName: 'x', toolInput: '', permissionId: 'p',
    })),
  };
}

function mockCtx(sessionId = 'loop-sid', workdir = '/tmp/test-project'): ScannerContext {
  return ScannerContext.fromWorkdir({
    sessionId, workdir, provider: 'claude', terminalUrl: 'http://test/?token=t',
  });
}

function mockConfig(): TLiveConfig {
  return {
    port: 8849, token: 'test', defaultProvider: 'claude',
    permissionTimeout: 55000, webEnabled: false,
    messageBatchDelay: 50, proactiveNotifyDelay: 100, proactiveQuestionDelay: 50,
  };
}

describe('TLiveLoop', () => {
  it('creates and starts a session', async () => {
    const loop = new TLiveLoop({ workdir: '/tmp/test-project', adapter: mockAdapter(), config: mockConfig(), sessionId: 'loop-sid', ctx: mockCtx('loop-sid', '/tmp/test-project') });
    expect(loop.sessionState).toBe('idle');
    expect(loop.sessionInfo.sessionId).toBe('loop-sid');

    await loop.start();
    expect(loop.sessionState).toBe('pty_active');

    await new Promise<void>((resolve) => {
      const check = () => { if (loop.sessionState === 'idle') resolve(); else setTimeout(check, 50); };
      setTimeout(check, 50);
    });
    await loop.stop();
  });

  it('forwards PTY data via event', async () => {
    const loop = new TLiveLoop({ workdir: '/tmp', adapter: mockAdapter(), config: mockConfig(), ctx: mockCtx('loop-sid', '/tmp') });
    const data: string[] = [];
    loop.on('ptyData', (d: string) => data.push(d));
    await loop.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(data.join('')).toContain('loop-test');
    await loop.stop();
  });

  it('sets IM target for notifications', () => {
    const loop = new TLiveLoop({ workdir: '/tmp', adapter: mockAdapter(), config: mockConfig(), ctx: mockCtx('loop-sid', '/tmp') });
    const sendFn = vi.fn().mockResolvedValue('msg-1');
    loop.setIMTarget('chat-123', sendFn);
    // No throw = success
    expect(true).toBe(true);
  });
});
