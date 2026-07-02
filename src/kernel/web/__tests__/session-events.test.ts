import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../session-registry';
import { applyMonitorEvent } from '../session-events';

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

  it('session-end → remove frame + purges registry', () => {
    const r = new SessionRegistry();
    r.upsert({ cwd: '/r', status: 'active' });
    const f = applyMonitorEvent(r, { event: 'session-end', cwd: '/r', sessionId: 's', reason: 'clear' });
    expect(f).toEqual({ type: 'session-remove', id: '/r' });
    expect(r.get('/r')).toBeUndefined();
  });
});
