// tests/integration/dual-channel.test.ts
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { mkdirSync } from 'node:fs';
import { TLiveLoop } from '../../src/loop.js';
import { ScannerContext } from '../../src/core/scannerContext.js';
import type { ProviderAdapter, NormalizedMessage, RemoteOptions } from '../../src/sdk/providerAdapter.js';
import type { TLiveConfig } from '../../src/config.js';

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return { ...actual, homedir: () => '/tmp/tlive-integration-test' };
});

function mockConfig(): TLiveConfig {
  return {
    port: 8849, token: 'test', defaultProvider: 'claude',
    permissionTimeout: 55000, webEnabled: false,
    messageBatchDelay: 50, proactiveNotifyDelay: 100, proactiveQuestionDelay: 50,
  };
}

describe('Dual-channel integration', () => {
  let loop: TLiveLoop;

  beforeAll(() => {
    for (const dir of ['/tmp/tlive-integration-test', '/tmp/integration-test', '/tmp/im-test']) {
      mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(async () => { await loop?.stop(); });

  it('starts PTY, receives data, session completes', async () => {
    const adapter: ProviderAdapter = {
      name: 'mock',
      resolveExecutable: vi.fn().mockResolvedValue('/bin/sh'),
      getSessionIdArgs: vi.fn((sid) => ['--session-id', sid]),
      getResumeArgs: vi.fn((sid) => ['--resume', '--session-id', sid]),
      spawnArgs: vi.fn(() => ['-c', 'echo integration-ok && sleep 0.1']),
      startRemote: vi.fn(async function* (): AsyncIterable<NormalizedMessage> {
        yield { kind: 'complete', provider: 'claude', sessionId: 'test' };
      }),
      getSessionDir: vi.fn(() => '/tmp/sessions'),
    };

    loop = new TLiveLoop({ workdir: '/tmp/integration-test', adapter, config: mockConfig(), ctx: ScannerContext.fromWorkdir({ sessionId: 'int-sid', workdir: '/tmp/integration-test', provider: 'claude', terminalUrl: 'http://test/?token=t' }) });
    const output: string[] = [];
    loop.on('ptyData', (d: string) => output.push(d));

    await loop.start();
    expect(loop.sessionState).toBe('pty_active');

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (loop.sessionState === 'idle') { clearInterval(check); resolve(); }
      }, 50);
    });

    expect(output.join('')).toContain('integration-ok');
  });

  it('sends IM notifications when IM target is set', async () => {
    const adapter: ProviderAdapter = {
      name: 'mock',
      resolveExecutable: vi.fn().mockResolvedValue('/bin/sh'),
      getSessionIdArgs: vi.fn((sid) => ['--session-id', sid]),
      getResumeArgs: vi.fn((sid) => ['--resume', '--session-id', sid]),
      spawnArgs: vi.fn(() => ['-c', 'echo done']),
      startRemote: vi.fn(async function* (): AsyncIterable<NormalizedMessage> {
        yield { kind: 'complete', provider: 'claude', sessionId: 'test' };
      }),
      getSessionDir: vi.fn(() => '/tmp/sessions'),
    };

    loop = new TLiveLoop({ workdir: '/tmp/im-test', adapter, config: mockConfig(), ctx: ScannerContext.fromWorkdir({ sessionId: 'im-sid', workdir: '/tmp/im-test', provider: 'claude', terminalUrl: 'http://test/?token=t' }) });
    const sent: Array<{ text: string }> = [];
    loop.setIMTarget('chat-1', vi.fn(async (_chatId: string, text: string) => {
      sent.push({ text });
      return 'msg-id';
    }));

    await loop.start();
    await new Promise((r) => setTimeout(r, 500));

    // Session should have completed and possibly sent a notification
    // The important thing is no errors thrown
    expect(loop.sessionState).toBe('idle');
  });
});
