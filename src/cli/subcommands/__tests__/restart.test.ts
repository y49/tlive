import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('runRestart', () => {
  it('proceeds when daemon running', async () => {
    mockRequest.mockResolvedValue({ kind: 'daemon.status', uptimeMs: 1000, pid: 999 });
    await runRestart([]);
    expect(mockRunStop).toHaveBeenCalled();
    expect(mockRunStart).toHaveBeenCalled();
  });

  it('proceeds when no daemon (status throws)', async () => {
    mockRequest.mockRejectedValue(new Error('no daemon'));
    await runRestart([]);
    expect(mockRunStop).toHaveBeenCalled();
    expect(mockRunStart).toHaveBeenCalled();
  });

  it('proceeds with --force flag', async () => {
    mockRequest.mockResolvedValue({ kind: 'daemon.status', uptimeMs: 1000, pid: 999 });
    await runRestart(['--force']);
    expect(mockRunStop).toHaveBeenCalled();
    expect(mockRunStart).toHaveBeenCalled();
  });
});
