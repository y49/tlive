import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/cli/ipc-client-lite.js', () => ({
  ensureDaemonRunning: vi.fn(async () => {}),
  sendRequest: vi.fn(async () => ({ type: 'ack', payload: { ok: true } })),
}));

import { stopCommand } from '../../src/cli/stop.js';

describe('stopCommand', () => {
  it('prints confirmation on ack', async () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await stopCommand('sid-123');
    write.mockRestore();
    expect(out.join('')).toContain('stopped sid-123');
  });

  it('prints usage when id missing and exits non-zero', async () => {
    const err: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => { err.push(String(s)); return true; });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => { throw new Error('exit'); }) as never);
    await stopCommand(undefined).catch(() => {});
    write.mockRestore();
    exit.mockRestore();
    expect(err.join('')).toContain('usage:');
  });
});
