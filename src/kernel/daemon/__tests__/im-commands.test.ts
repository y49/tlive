import { describe, it, expect } from 'vitest';
import { parseImCommand } from '../im-commands';

describe('parseImCommand', () => {
  it('recognizes /use <ws>', () => {
    expect(parseImCommand('/use ws-foo')).toEqual({ kind: 'use', workspaceId: 'ws-foo' });
  });

  it('recognizes /new', () => {
    expect(parseImCommand('/new')).toEqual({ kind: 'new' });
  });

  it('recognizes /sessions', () => {
    expect(parseImCommand('/sessions')).toEqual({ kind: 'sessions' });
  });

  it('recognizes /resume <id>', () => {
    expect(parseImCommand('/resume abc-123')).toEqual({ kind: 'resume', sessionId: 'abc-123' });
  });

  it('recognizes /handback', () => {
    expect(parseImCommand('/handback')).toEqual({ kind: 'handback' });
  });

  it('recognizes /stop and /kill', () => {
    expect(parseImCommand('/stop')).toEqual({ kind: 'stop' });
    expect(parseImCommand('/kill')).toEqual({ kind: 'kill' });
  });

  it('recognizes /model <name>', () => {
    expect(parseImCommand('/model claude-opus-4-7')).toEqual({ kind: 'model', name: 'claude-opus-4-7' });
  });

  it('recognizes /runtime <p>', () => {
    expect(parseImCommand('/runtime claude')).toEqual({ kind: 'runtime', provider: 'claude' });
    expect(parseImCommand('/runtime codex')).toEqual({ kind: 'runtime', provider: 'codex' });
  });

  it('recognizes /perm on|off', () => {
    expect(parseImCommand('/perm on')).toEqual({ kind: 'perm', enabled: true });
    expect(parseImCommand('/perm off')).toEqual({ kind: 'perm', enabled: false });
  });

  it('recognizes /help', () => {
    expect(parseImCommand('/help')).toEqual({ kind: 'help' });
  });

  it('returns null for non-command text', () => {
    expect(parseImCommand('hello there')).toBeNull();
    expect(parseImCommand('/unknown')).toEqual({ kind: 'unknown', name: 'unknown' });
  });
});
