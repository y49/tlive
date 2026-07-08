import { describe, it, expect } from 'vitest';
import { parseHookArgs } from '../hook';

describe('parseHookArgs', () => {
  it('无 flag → claude', () => {
    expect(parseHookArgs(['pre-tool-use'])).toEqual({ event: 'pre-tool-use', vendor: 'claude' });
  });
  it('--codex 在前', () => {
    expect(parseHookArgs(['--codex', 'pre-tool-use'])).toEqual({ event: 'pre-tool-use', vendor: 'codex' });
  });
  it('--codex 在后', () => {
    expect(parseHookArgs(['stop', '--codex'])).toEqual({ event: 'stop', vendor: 'codex' });
  });
  it('无事件', () => {
    expect(parseHookArgs(['--codex'])).toEqual({ event: undefined, vendor: 'codex' });
  });
});
