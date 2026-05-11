import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequest = vi.fn();
const mockRunStop = vi.fn(async () => {});
const mockRunStart = vi.fn(async () => {});

vi.mock('../../../kernel/ipc/client', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));
vi.mock('../stop', () => ({ runStop: mockRunStop }));
vi.mock('../start', () => ({ runStart: mockRunStart }));

let exitCode: number | null = null;
const origExit = process.exit;
const exitSpy = vi.fn((code?: number) => {
  exitCode = code ?? 0;
  throw new Error(`__exit_${exitCode}`);
});

beforeEach(() => {
  exitCode = null;
  mockRequest.mockReset();
  mockRunStop.mockReset();
  mockRunStart.mockReset();
  process.exit = exitSpy as unknown as typeof process.exit;
});

afterEach(() => { process.exit = origExit; });

import { runRestart } from '../restart';

import { afterEach } from 'vitest';

describe('runRestart guard', () => {
  it('refuses with code 2 when active sessions and no --force', async () => {
    mockRequest.mockResolvedValue({ kind: 'daemon.status', uptimeMs: 1000, pid: 999, sessionCount: 2 });
    await expect(runRestart([])).rejects.toThrow('__exit_2');
    expect(mockRunStop).not.toHaveBeenCalled();
  });

  it('proceeds when --force given even with active sessions', async () => {
    mockRequest.mockResolvedValue({ kind: 'daemon.status', uptimeMs: 1000, pid: 999, sessionCount: 5 });
    await runRestart(['--force']);
    expect(mockRunStop).toHaveBeenCalled();
    expect(mockRunStart).toHaveBeenCalled();
  });

  it('proceeds when no daemon (status throws)', async () => {
    mockRequest.mockRejectedValue(new Error('no daemon'));
    await runRestart([]);
    expect(mockRunStop).toHaveBeenCalled();
    expect(mockRunStart).toHaveBeenCalled();
  });

  it('proceeds when daemon up but 0 active sessions', async () => {
    mockRequest.mockResolvedValue({ kind: 'daemon.status', uptimeMs: 1000, pid: 999, sessionCount: 0 });
    await runRestart([]);
    expect(mockRunStop).toHaveBeenCalled();
    expect(mockRunStart).toHaveBeenCalled();
  });
});
