import { describe, it, expect } from 'vitest';
import { parseImCommand } from '../im-commands';

describe('parseImCommand (M1: use/perm/help)', () => {
  it('recognizes /use <ws>', () => {
    expect(parseImCommand('/use ws-foo')).toEqual({ kind: 'use', workspaceId: 'ws-foo' });
  });

  it('/use without arg → unknown', () => {
    expect(parseImCommand('/use')).toEqual({ kind: 'unknown', name: 'use' });
  });

  it('recognizes /perm on|off', () => {
    expect(parseImCommand('/perm on')).toEqual({ kind: 'perm', enabled: true });
    expect(parseImCommand('/perm off')).toEqual({ kind: 'perm', enabled: false });
  });

  it('/perm with bad arg → unknown', () => {
    expect(parseImCommand('/perm maybe')).toEqual({ kind: 'unknown', name: 'perm' });
  });

  it('recognizes /help', () => {
    expect(parseImCommand('/help')).toEqual({ kind: 'help' });
  });

  it('returns null for non-command text', () => {
    expect(parseImCommand('hello there')).toBeNull();
  });

  it('unknown slash command → unknown kind', () => {
    expect(parseImCommand('/unknown')).toEqual({ kind: 'unknown', name: 'unknown' });
  });
});
