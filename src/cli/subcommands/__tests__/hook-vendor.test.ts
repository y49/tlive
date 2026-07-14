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

describe('approvalWindow (claude-only remote-approval window)', () => {
  it('default: 30min parallel', () => {
    expect(approvalWindow()).toEqual({ timeoutSec: 1800, ipcMs: 1_900_000 });
  });
  it('config override is honored', () => {
    expect(approvalWindow({ claudeWindowSec: 3600 }).timeoutSec).toBe(3600);
  });
  it('clamps: max 86200', () => {
    expect(approvalWindow({ claudeWindowSec: 999_999 }).timeoutSec).toBe(86_200);
    expect(approvalWindow({ claudeWindowSec: 1 }).timeoutSec).toBe(60);
  });
});
