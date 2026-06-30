import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../session-registry';
import type { SessionMeta } from '../../ipc/protocol';

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 's1', label: 'cat @ tmp', cmd: 'cat', cwd: '/tmp', pid: 123, sockPath: '/tmp/s1.sock', ...over,
});

describe('SessionRegistry', () => {
  it('registers, gets, lists', () => {
    const r = new SessionRegistry();
    r.register(meta());
    expect(r.get('s1')?.cmd).toBe('cat');
    expect(r.list()).toHaveLength(1);
  });
  it('re-registering same id overwrites', () => {
    const r = new SessionRegistry();
    r.register(meta());
    r.register(meta({ label: 'updated' }));
    expect(r.list()).toHaveLength(1);
    expect(r.get('s1')?.label).toBe('updated');
  });
  it('unregister removes; unknown id is a no-op', () => {
    const r = new SessionRegistry();
    r.register(meta());
    r.unregister('nope');
    expect(r.list()).toHaveLength(1);
    r.unregister('s1');
    expect(r.list()).toHaveLength(0);
    expect(r.get('s1')).toBeUndefined();
  });
});
