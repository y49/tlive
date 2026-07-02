import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../session-registry';
import type { SessionMeta } from '../../ipc/protocol';

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 's1', label: 'cat @ tmp', cmd: 'cat', cwd: '/tmp', pid: 123, sockPath: '/tmp/s1.sock', ...over,
});

describe('SessionRegistry rich model', () => {
  it('register maps a wrapped session, keyed by cwd (id = cwd)', () => {
    const r = new SessionRegistry();
    const v = r.register(meta());
    expect(v.id).toBe('/tmp');
    expect(v.cwd).toBe('/tmp');
    expect(v.kind).toBe('wrapped');
    expect(v.sockPath).toBe('/tmp/s1.sock');
    expect(v.muted).toBe(false);
    expect(r.get('/tmp')?.label).toBe('cat @ tmp');
    expect(r.list()).toHaveLength(1);
  });

  it('unregister removes by the wrapped meta id', () => {
    const r = new SessionRegistry();
    r.register(meta());
    expect(r.unregister('nope')).toBeUndefined();
    expect(r.list()).toHaveLength(1);
    const removed = r.unregister('s1');
    expect(removed?.id).toBe('/tmp');
    expect(r.list()).toHaveLength(0);
  });

  it('upsert creates a hook session with defaults', () => {
    const r = new SessionRegistry();
    const v = r.upsert({ cwd: '/repo', status: 'active', lastActivityAt: 1000 });
    expect(v).toEqual({ id: '/repo', cwd: '/repo', label: 'repo', kind: 'hook', status: 'active', lastActivityAt: 1000, muted: false });
  });

  it('upsert merges into the same cwd and keeps wrapped kind sticky', () => {
    const r = new SessionRegistry();
    r.register(meta({ cwd: '/repo', sockPath: '/s.sock' }));
    const v = r.upsert({ cwd: '/repo', status: 'waiting-input', lastMessage: 'done', lastActivityAt: 2000 });
    expect(v.kind).toBe('wrapped');     // not downgraded to hook
    expect(v.sockPath).toBe('/s.sock'); // preserved
    expect(v.status).toBe('waiting-input');
    expect(v.lastMessage).toBe('done');
  });

  it('upsert sets and clears pending (pending:null clears)', () => {
    const r = new SessionRegistry();
    r.upsert({ cwd: '/repo', pending: { requestId: 'r1', title: 'T', body: 'B' }, status: 'waiting-approval', lastActivityAt: 1 });
    expect(r.get('/repo')?.pending?.requestId).toBe('r1');
    const v = r.upsert({ cwd: '/repo', pending: null, status: 'active', lastActivityAt: 2 });
    expect(v.pending).toBeUndefined();
    expect(v.status).toBe('active');
  });

  it('remove returns the removed view and purges the meta-id mapping', () => {
    const r = new SessionRegistry();
    r.register(meta({ cwd: '/repo' }));
    expect(r.remove('/repo')?.cwd).toBe('/repo');
    expect(r.unregister('s1')).toBeUndefined(); // mapping purged
  });
});
