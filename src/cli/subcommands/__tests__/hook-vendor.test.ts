import { describe, it, expect } from 'vitest';
import { parseHookArgs } from '../hook';

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
