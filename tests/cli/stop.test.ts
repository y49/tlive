import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/ipc/client.js', () => ({
  ensureDaemonRunning: vi.fn(async () => {}),
  request: vi.fn(async () => ({ kind: 'session.stopped', sdkSessionId: 'sid-123' })),
}));

import { stopCommand } from '../../src/cli/stop.js';

describe('stopCommand', () => {
  it('prints confirmation on session.stopped', async () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await stopCommand('sid-123');
    write.mockRestore();
    expect(out.join('')).toContain('stopped sid-123');
  });

  it('prints usage when alias missing and exits non-zero', async () => {
    const err: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => { err.push(String(s)); return true; });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => { throw new Error('exit'); }) as never);
    await stopCommand(undefined).catch(() => {});
    write.mockRestore();
    exit.mockRestore();
    expect(err.join('')).toContain('usage:');
  });
});
