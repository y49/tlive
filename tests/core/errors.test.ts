import { describe, it, expect } from 'vitest';
import { TLiveError, classifyError } from '../../src/core/errors.js';

describe('TLiveError', () => {
  it('classifies abort errors', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const classified = classifyError(err);
    expect(classified.code).toBe('ABORT');
    expect(classified.isUserInitiated).toBe(true);
    expect(classified.shouldNotifyIM).toBe(false);
  });

  it('classifies connection errors as retryable', () => {
    const err = new Error('connect ECONNREFUSED');
    const classified = classifyError(err);
    expect(classified.code).toBe('IPC_DISCONNECT');
    expect(classified.isRetryable).toBe(true);
  });

  it('classifies unknown errors as SDK_ERROR', () => {
    const classified = classifyError(new Error('something broke'));
    expect(classified.code).toBe('SDK_ERROR');
    expect(classified.shouldNotifyIM).toBe(true);
  });

  it('passes through TLiveError unchanged', () => {
    const err = new TLiveError('test', 'PTY_EXIT');
    expect(classifyError(err)).toBe(err);
  });
});
