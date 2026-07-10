import { describe, it, expect } from 'vitest';
import { parseHookArgs, approvalWindow } from '../hook';

describe('parseHookArgs', () => {
  it('no flag → claude', () => {
    expect(parseHookArgs(['permission-request'])).toEqual({ event: 'permission-request', vendor: 'claude' });
  });
  it('--codex before event', () => {
    expect(parseHookArgs(['--codex', 'permission-request'])).toEqual({ event: 'permission-request', vendor: 'codex' });
  });
  it('--codex 在后', () => {
    expect(parseHookArgs(['stop', '--codex'])).toEqual({ event: 'stop', vendor: 'codex' });
  });
  it('无事件', () => {
    expect(parseHookArgs(['--codex'])).toEqual({ event: undefined, vendor: 'codex' });
  });
});

describe('approvalWindow (per-vendor remote-approval window)', () => {
  it('defaults: claude 30min parallel, codex ~10min serial', () => {
    expect(approvalWindow('claude')).toEqual({ timeoutSec: 1800, ipcMs: 1_900_000 });
    expect(approvalWindow('codex')).toEqual({ timeoutSec: 590, ipcMs: 690_000 });
  });
  it('config overrides are honored', () => {
    expect(approvalWindow('codex', { codexWindowSec: 1800 }).timeoutSec).toBe(1800);
    expect(approvalWindow('claude', { claudeWindowSec: 3600 }).timeoutSec).toBe(3600);
  });
  it('clamps: codex max 2h (serial hook freezes the terminal), claude max 86200', () => {
    expect(approvalWindow('codex', { codexWindowSec: 999_999 }).timeoutSec).toBe(7200);
    expect(approvalWindow('claude', { claudeWindowSec: 999_999 }).timeoutSec).toBe(86_200);
    expect(approvalWindow('codex', { codexWindowSec: 1 }).timeoutSec).toBe(60);
  });
  it('ipc deadline sits 100s above the window (inside the vendor hook timeout)', () => {
    const w = approvalWindow('codex', { codexWindowSec: 7200 });
    expect(w.ipcMs).toBe(7_300_000); // < 7320s vendor timeout
  });
});
