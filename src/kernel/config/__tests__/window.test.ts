import { describe, it, expect } from 'vitest';
import { approvalWindow } from '../window';

describe('approvalWindow (shared remote-approval window)', () => {
  it('config override is honored', () => {
    expect(approvalWindow({ windowSec: 3600 }).timeoutSec).toBe(3600);
  });
  it('clamps: max 86200', () => {
    expect(approvalWindow({ windowSec: 999_999 }).timeoutSec).toBe(86_200);
    expect(approvalWindow({ windowSec: 1 }).timeoutSec).toBe(60);
  });
});

describe('approvalWindow — 24h default', () => {
  it('defaults to 86200 (clamp ceiling, leaves +100s room under the 86400 vendor timeout)', () => {
    expect(approvalWindow(undefined).timeoutSec).toBe(86_200);
    expect(approvalWindow({}).timeoutSec).toBe(86_200);
  });

  it('keeps shim IPC deadline inside the vendor timeout', () => {
    const w = approvalWindow(undefined);
    expect(w.ipcMs).toBe((86_200 + 100) * 1000);
    expect(w.ipcMs / 1000).toBeLessThan(86_400); // vendor hook timeout
  });

  it('reads windowSec and clamps to [60, 86200]', () => {
    expect(approvalWindow({ windowSec: 600 }).timeoutSec).toBe(600);
    expect(approvalWindow({ windowSec: 1 }).timeoutSec).toBe(60);
    expect(approvalWindow({ windowSec: 999_999 }).timeoutSec).toBe(86_200);
  });
});
