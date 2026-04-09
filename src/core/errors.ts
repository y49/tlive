// src/core/errors.ts
export type ErrorCode =
  | 'ABORT'
  | 'PTY_EXIT'
  | 'IPC_DISCONNECT'
  | 'SDK_ERROR'
  | 'SCANNER_ERROR';

export class TLiveError extends Error {
  constructor(message: string, public readonly code: ErrorCode, public readonly cause?: unknown) {
    super(message);
    this.name = 'TLiveError';
  }

  get isRetryable(): boolean {
    return this.code === 'IPC_DISCONNECT' || this.code === 'SCANNER_ERROR';
  }

  get shouldNotifyIM(): boolean {
    return this.code === 'SDK_ERROR' || this.code === 'PTY_EXIT';
  }

  get isUserInitiated(): boolean {
    return this.code === 'ABORT';
  }
}

export function classifyError(err: unknown): TLiveError {
  if (err instanceof TLiveError) return err;
  const e = err as Error;
  if (e.name === 'AbortError') return new TLiveError(e.message, 'ABORT', e);
  if (e.message?.includes('ECONNREFUSED') || e.message?.includes('EPIPE')) {
    return new TLiveError(e.message, 'IPC_DISCONNECT', e);
  }
  return new TLiveError(e.message ?? String(err), 'SDK_ERROR', e);
}
