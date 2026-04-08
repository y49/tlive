import { describe, it, expect, vi } from 'vitest';
import { SessionManager, type SessionState } from '../../src/core/sessionManager.js';
import type { ProviderAdapter, NormalizedMessage, RemoteOptions } from '../../src/sdk/providerAdapter.js';

function createMockAdapter(): ProviderAdapter {
  return {
    name: 'mock-claude',
    resolveExecutable: vi.fn().mockResolvedValue('/usr/bin/echo'),
    getSessionIdArgs: vi.fn((sid) => ['--session-id', sid]),
    getResumeArgs: vi.fn((sid) => ['--resume', '--session-id', sid]),
    spawnArgs: vi.fn((opts) => ['--session-id', opts.sessionId, 'test-mode']),
    startRemote: vi.fn(async function* (opts: RemoteOptions): AsyncIterable<NormalizedMessage> {
      yield { kind: 'text', provider: 'claude', sessionId: opts.sessionId, text: 'hello' };
      yield { kind: 'complete', provider: 'claude', sessionId: opts.sessionId };
    }),
    getSessionDir: vi.fn(() => '/tmp/sessions'),
  };
}

const mockConfig = {
  permissionTimeout: 55000,
  proactiveNotifyDelay: 60000,
  proactiveQuestionDelay: 5000,
} as any;

describe('SessionManager', () => {
  it('starts in idle state', () => {
    const sm = new SessionManager({ workdir: '/tmp/test', adapter: createMockAdapter(), config: mockConfig });
    expect(sm.state).toBe('idle');
  });

  it('transitions to pty_active on startPTY', async () => {
    const adapter = createMockAdapter();
    adapter.spawnArgs = vi.fn(() => ['-c', 'echo done']);
    adapter.resolveExecutable = vi.fn().mockResolvedValue('/bin/sh');

    const sm = new SessionManager({ workdir: '/tmp', adapter, config: mockConfig });
    const states: SessionState[] = [];
    sm.on('stateChange', (s: SessionState) => states.push(s));

    await sm.startPTY();
    expect(sm.state).toBe('pty_active');
    expect(states).toContain('pty_active');

    await new Promise<void>((resolve) => sm.on('sessionComplete', () => resolve()));
    expect(sm.state).toBe('idle');
    await sm.stop();
  });

  it('rejects startPTY when not idle', async () => {
    const adapter = createMockAdapter();
    adapter.resolveExecutable = vi.fn().mockResolvedValue('/bin/sleep');
    adapter.spawnArgs = vi.fn(() => ['10']);

    const sm = new SessionManager({ workdir: '/tmp', adapter, config: mockConfig });
    await sm.startPTY();
    await expect(sm.startPTY()).rejects.toThrow('Cannot start PTY');
    await sm.stop();
  });

  it('provides session info', () => {
    const sm = new SessionManager({ sessionId: 'test-sid', workdir: '/proj', adapter: createMockAdapter(), config: mockConfig });
    const info = sm.info;
    expect(info.sessionId).toBe('test-sid');
    expect(info.workdir).toBe('/proj');
    expect(info.state).toBe('idle');
  });
});
