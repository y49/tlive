import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../session-registry';
import type { SessionMeta } from '../../ipc/protocol';

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 's1', label: 'cat @ tmp', cmd: 'cat', cwd: '/tmp', pid: 123, sockPath: '/tmp/s1.sock', ...over,
});

describe('SessionRegistry rich model', () => {
  it('register maps a wrapped session, keyed by its run uuid', () => {
    const r = new SessionRegistry();
    const v = r.register(meta());
    expect(v.id).toBe('s1');
    expect(v.cwd).toBe('/tmp');
    expect(v.kind).toBe('wrapped');
    expect(v.sockPath).toBe('/tmp/s1.sock');
    expect(v.muted).toBe(false);
    expect(r.get('s1')?.label).toBe('cat @ tmp');
    expect(r.list()).toHaveLength(1);
  });

  it('two wrapped sessions may share one cwd (distinct uuid keys)', () => {
    const r = new SessionRegistry();
    r.register(meta({ id: 'a1', label: 'claude', sockPath: '/a.sock' }));
    r.register(meta({ id: 'b2', label: 'bash', sockPath: '/b.sock' }));
    expect(r.list()).toHaveLength(2);
    expect(r.get('a1')?.sockPath).toBe('/a.sock');
    expect(r.get('b2')?.sockPath).toBe('/b.sock');
    r.unregister('a1');
    expect(r.get('b2')).toBeDefined(); // removing one never touches the other
  });

  it('unregister removes by the wrapped meta id', () => {
    const r = new SessionRegistry();
    r.register(meta());
    expect(r.unregister('nope')).toBeUndefined();
    expect(r.list()).toHaveLength(1);
    const removed = r.unregister('s1');
    expect(removed?.id).toBe('s1');
    expect(r.list()).toHaveLength(0);
  });

  it('upsert creates a hook session with defaults', () => {
    const r = new SessionRegistry();
    const v = r.upsert({ cwd: '/repo', status: 'active', lastActivityAt: 1000 });
    expect(v).toEqual({ id: '/repo', cwd: '/repo', label: 'repo', kind: 'hook', status: 'active', lastActivityAt: 1000, muted: false });
  });

  it('keyed upsert (hook attribution via TLIVE_SESSION) merges into the wrapped card', () => {
    const r = new SessionRegistry();
    r.register(meta({ id: 's1', cwd: '/repo', sockPath: '/s.sock' }));
    const v = r.upsert({ key: 's1', cwd: '/repo', status: 'waiting-input', lastMessage: 'done', lastActivityAt: 2000 });
    expect(v.kind).toBe('wrapped');     // not downgraded to hook
    expect(v.sockPath).toBe('/s.sock'); // preserved
    expect(v.status).toBe('waiting-input');
    expect(v.lastMessage).toBe('done');
    expect(r.list()).toHaveLength(1); // merged, not a second card
  });

  it('upsert sets and clears pending (pending:null clears)', () => {
    const r = new SessionRegistry();
    r.upsert({ cwd: '/repo', pending: { requestId: 'r1', title: 'T', body: 'B' }, status: 'waiting-approval', lastActivityAt: 1 });
    expect(r.get('/repo')?.pending?.requestId).toBe('r1');
    const v = r.upsert({ cwd: '/repo', pending: null, status: 'active', lastActivityAt: 2 });
    expect(v.pending).toBeUndefined();
    expect(v.status).toBe('active');
  });

  it('remove returns the removed view; a second unregister is a no-op', () => {
    const r = new SessionRegistry();
    r.register(meta({ cwd: '/repo' }));
    expect(r.remove('s1')?.cwd).toBe('/repo');
    expect(r.unregister('s1')).toBeUndefined();
  });

  it('upsert sets and clears continueId (continueId:null clears)', () => {
    const r = new SessionRegistry();
    r.upsert({ cwd: '/repo', status: 'waiting-input', continueId: 'c1', lastActivityAt: 1 });
    expect(r.get('/repo')?.continueId).toBe('c1');
    // an unrelated merge leaves continueId intact
    const kept = r.upsert({ cwd: '/repo', lastMessage: 'x', lastActivityAt: 2 });
    expect(kept.continueId).toBe('c1');
    const cleared = r.upsert({ cwd: '/repo', continueId: null, status: 'active', lastActivityAt: 3 });
    expect(cleared.continueId).toBeUndefined();
  });

  it('setMuted toggles per-session mute; returns undefined for an unknown id', () => {
    const r = new SessionRegistry();
    r.upsert({ cwd: '/repo', status: 'idle', lastActivityAt: 1 });
    expect(r.setMuted('/repo', true)?.muted).toBe(true);
    expect(r.get('/repo')?.muted).toBe(true);
    expect(r.setMuted('/repo', false)?.muted).toBe(false);
    expect(r.setMuted('/nope', true)).toBeUndefined();
  });
});
