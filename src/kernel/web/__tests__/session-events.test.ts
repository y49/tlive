import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../session-registry';
import { applyMonitorEvent, sweepDeadSessions } from '../session-events';

describe('applyMonitorEvent', () => {
  it('activity → active upsert frame', () => {
    const r = new SessionRegistry();
    const f = applyMonitorEvent(r, { event: 'activity', cwd: '/r', sessionId: 's', toolName: 'Bash', result: {} });
    expect(f.type).toBe('session-upsert');
    if (f.type === 'session-upsert') expect(f.session.status).toBe('active');
    expect(r.get('/r')?.status).toBe('active');
  });

  it('attention → waiting-input, lastMessage falls back to message', () => {
    const r = new SessionRegistry();
    const f = applyMonitorEvent(r, { event: 'attention', cwd: '/r', sessionId: 's', message: 'need you' });
    if (f.type === 'session-upsert') {
      expect(f.session.status).toBe('waiting-input');
      expect(f.session.lastMessage).toBe('need you');
    }
  });

  it('attention prefers lastMessage over message', () => {
    const r = new SessionRegistry();
    const f = applyMonitorEvent(r, { event: 'attention', cwd: '/r', sessionId: 's', message: 'done', lastMessage: 'here is the result' });
    if (f.type === 'session-upsert') expect(f.session.lastMessage).toBe('here is the result');
  });

  it('prompt → active + lastPrompt', () => {
    const r = new SessionRegistry();
    const f = applyMonitorEvent(r, { event: 'prompt', cwd: '/r', sessionId: 's', prompt: 'do X' });
    if (f.type === 'session-upsert') {
      expect(f.session.status).toBe('active');
      expect(f.session.lastPrompt).toBe('do X');
    }
  });

  it('session-start → idle hook session', () => {
    const r = new SessionRegistry();
    const f = applyMonitorEvent(r, { event: 'session-start', cwd: '/r', sessionId: 's', source: 'startup' });
    if (f.type === 'session-upsert') {
      expect(f.session.kind).toBe('hook');
      expect(f.session.status).toBe('idle');
    }
  });

  it('session-end → remove frame + purges registry (hook-kind)', () => {
    const r = new SessionRegistry();
    r.upsert({ cwd: '/r', status: 'active' });
    const f = applyMonitorEvent(r, { event: 'session-end', cwd: '/r', sessionId: 's', reason: 'clear' });
    expect(f).toEqual({ type: 'session-remove', id: '/r' });
    expect(r.get('/r')).toBeUndefined();
  });

  it('session-end preserves wrapped session on /clear (kind-aware: downgrade to idle)', () => {
    const r = new SessionRegistry();
    // register a wrapped session (tlive run)
    r.register({ id: 'u1', label: 'myapp', cmd: 'claude', cwd: '/w', pid: 1, sockPath: '/s.sock' });
    const f = applyMonitorEvent(r, { event: 'session-end', cwd: '/w', sessionId: 's', reason: 'clear' });
    // returns upsert (not remove) — session survives
    expect(f.type).toBe('session-upsert');
    if (f.type === 'session-upsert') {
      expect(f.session.kind).toBe('wrapped');
      expect(f.session.status).toBe('idle');
      expect(f.session.sockPath).toBe('/s.sock');
    }
    // registry still has the session
    const v = r.get('/w');
    expect(v).toBeDefined();
    expect(v?.kind).toBe('wrapped');
    expect(v?.sockPath).toBe('/s.sock');
    // actual removal happens via unregister(metaId) — metaId→cwd mapping still intact
    r.unregister('u1');
    expect(r.get('/w')).toBeUndefined();
  });

  it('session-end removes hook-kind session (not wrapped)', () => {
    const r = new SessionRegistry();
    r.upsert({ cwd: '/h', kind: 'hook', status: 'active' });
    const f = applyMonitorEvent(r, { event: 'session-end', cwd: '/h', sessionId: 's', reason: 'exit' });
    expect(f).toEqual({ type: 'session-remove', id: '/h' });
    expect(r.get('/h')).toBeUndefined();
  });
});

describe('sweepDeadSessions', () => {
  it('removes wrapped sessions with a dead pid and returns remove-frames', () => {
    const r = new SessionRegistry();
    r.register({ id: 'u1', label: 'a', cmd: 'x', cwd: '/dead', pid: 111, sockPath: '/a.sock' });
    r.register({ id: 'u2', label: 'b', cmd: 'x', cwd: '/live', pid: 222, sockPath: '/b.sock' });
    r.upsert({ cwd: '/hook', kind: 'hook', status: 'active' }); // no pid — never swept
    const frames = sweepDeadSessions(r, (pid) => pid === 222);
    expect(frames).toEqual([{ type: 'session-remove', id: '/dead' }]);
    expect(r.get('/dead')).toBeUndefined();
    expect(r.get('/live')).toBeDefined();
    expect(r.get('/hook')).toBeDefined();
  });
});
