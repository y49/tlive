import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../session-registry';
import { applyMonitorEvent, sweepDeadSessions } from '../session-events';

describe('attention with no content of its own', () => {
  it('leaves an existing lastMessage alone — an empty message means the notification had no content worth showing', () => {
    const sessions = new SessionRegistry();
    sessions.upsert({ key: 's1', cwd: '/w/repo', lastMessage: 'Fixed the retry path; 932 tests pass' });
    applyMonitorEvent(sessions, { event: 'attention', cwd: '/w/repo', sessionId: 's1', message: '' }, 's1');
    expect(sessions.get('s1')?.lastMessage).toBe('Fixed the retry path; 932 tests pass');
  });

  it('still records a failure notification, which is the dashboard\'s only view of a failed tool call', () => {
    const sessions = new SessionRegistry();
    sessions.upsert({ key: 's1', cwd: '/w/repo', lastMessage: 'earlier' });
    applyMonitorEvent(sessions, { event: 'attention', cwd: '/w/repo', sessionId: 's1', message: 'Bash failed: permission denied' }, 's1');
    expect(sessions.get('s1')?.lastMessage).toBe('Bash failed: permission denied');
  });
});

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

  it('session-start records the agent pid, so a killed session can be reaped', () => {
    const r = new SessionRegistry();
    const f = applyMonitorEvent(r, { event: 'session-start', cwd: '/r', sessionId: 's' }, '/r', 4242);
    if (f.type === 'session-upsert') expect(f.session.pid).toBe(4242);
    expect(r.get('/r')?.pid).toBe(4242);
  });

  it('records the agent pid on any event, not just session-start', () => {
    // A daemon restarted mid-session never sees that session's SessionStart:
    // the entry is re-created by whatever hook fires next, and it must still
    // carry the pid or it can never be swept.
    const r = new SessionRegistry();
    applyMonitorEvent(r, { event: 'activity', cwd: '/r', sessionId: 's', toolName: 'Bash', result: {} }, '/r', 4242);
    expect(r.get('/r')?.pid).toBe(4242);
  });

  it('never stamps the agent pid over a wrapped session (the sweep watches `tlive run`)', () => {
    // Hooks fired inside a `tlive run` pty carry TLIVE_SESSION, so they land on
    // the wrapped session's key. Its pid must stay the `tlive run` process —
    // the one whose death means the pty is gone. Overwriting it with the
    // agent's pid would reap a live terminal the moment the agent exited.
    const r = new SessionRegistry();
    r.register({ id: 'u1', label: 'a', cmd: 'x', cwd: '/w', pid: 111, sockPath: '/a.sock' });
    applyMonitorEvent(r, { event: 'activity', cwd: '/w', sessionId: 's', toolName: 'Bash', result: {} }, 'u1', 4242);
    expect(r.get('u1')?.pid).toBe(111);
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
    const f = applyMonitorEvent(r, { event: 'session-end', cwd: '/w', sessionId: 's', reason: 'clear' }, 'u1');
    // returns upsert (not remove) — session survives
    expect(f.type).toBe('session-upsert');
    if (f.type === 'session-upsert') {
      expect(f.session.kind).toBe('wrapped');
      expect(f.session.status).toBe('idle');
      expect(f.session.sockPath).toBe('/s.sock');
    }
    // registry still has the session
    const v = r.get('u1');
    expect(v).toBeDefined();
    expect(v?.kind).toBe('wrapped');
    expect(v?.sockPath).toBe('/s.sock');
    // actual removal happens via unregister(metaId) — metaId→cwd mapping still intact
    r.unregister('u1');
    expect(r.get('u1')).toBeUndefined();
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
    expect(frames).toEqual([{ type: 'session-remove', id: 'u1' }]);
    expect(r.get('u1')).toBeUndefined();
    expect(r.get('u2')).toBeDefined();
    expect(r.get('/hook')).toBeDefined();
  });

  it('removes hook sessions whose agent process died without firing SessionEnd', () => {
    // kill -9 / crash / terminal closed hard: no hook runs, so the only
    // retirement path a hook session had (SessionEnd) never fires and the
    // entry strands forever — a phantom on the dashboard that IM replies
    // still route to.
    const r = new SessionRegistry();
    r.upsert({ cwd: '/gone', kind: 'hook', status: 'active', pid: 333 });
    r.upsert({ cwd: '/alive', kind: 'hook', status: 'active', pid: 444 });
    const frames = sweepDeadSessions(r, (pid) => pid === 444);
    expect(frames).toEqual([{ type: 'session-remove', id: '/gone' }]);
    expect(r.get('/gone')).toBeUndefined();
    expect(r.get('/alive')).toBeDefined();
  });
});

describe('applyMonitorEvent subagent 计数', () => {
  it('start 累加、stop 递减、clamp ≥0', () => {
    const reg = new SessionRegistry();
    const key = '/proj';
    const sub = (delta: 1 | -1) => applyMonitorEvent(reg, { event: 'subagent', cwd: key, sessionId: 's', delta } as any, key);
    expect((sub(1).session as any).activeSubagents).toBe(1);
    expect((sub(1).session as any).activeSubagents).toBe(2);
    expect((sub(-1).session as any).activeSubagents).toBe(1);
    expect((sub(-1).session as any).activeSubagents).toBe(0);
    expect((sub(-1).session as any).activeSubagents).toBe(0); // 不成对也不变负
  });
  it('subagent 事件把会话标 active', () => {
    const reg = new SessionRegistry();
    const f = applyMonitorEvent(reg, { event: 'subagent', cwd: '/p', sessionId: 's', delta: 1 } as any, '/p');
    expect(f.type).toBe('session-upsert');
    if (f.type === 'session-upsert') expect(f.session.status).toBe('active');
  });
});
