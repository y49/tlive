import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRegistry } from '../registry';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tlive-ws-'));
});

describe('WorkspaceRegistry', () => {
  it('add + list + remove round-trip', () => {
    const r = new WorkspaceRegistry({ home: tmp });
    r.add('ws-foo', '/projects/foo');
    r.add('ws-bar', '/projects/bar');
    expect(r.list()).toEqual([
      { id: 'ws-foo', path: '/projects/foo' },
      { id: 'ws-bar', path: '/projects/bar' },
    ]);
    r.remove('ws-foo');
    expect(r.list()).toEqual([{ id: 'ws-bar', path: '/projects/bar' }]);
  });

  it('lookupByCwd returns longest-prefix match', () => {
    const r = new WorkspaceRegistry({ home: tmp });
    r.add('ws-a', '/projects/foo');
    r.add('ws-b', '/projects/foo/bar');
    expect(r.lookupByCwd('/projects/foo/bar/sub')?.id).toBe('ws-b');
    expect(r.lookupByCwd('/projects/foo/baz')?.id).toBe('ws-a');
    expect(r.lookupByCwd('/projects/zzz')).toBeNull();
  });

  it('persists to ~/.tlive/config.json', () => {
    const r1 = new WorkspaceRegistry({ home: tmp });
    r1.add('ws-x', '/x');
    const r2 = new WorkspaceRegistry({ home: tmp });
    expect(r2.list()).toEqual([{ id: 'ws-x', path: '/x' }]);
  });

  it('rejects duplicate id', () => {
    const r = new WorkspaceRegistry({ home: tmp });
    r.add('ws', '/a');
    expect(() => r.add('ws', '/b')).toThrow(/already exists/);
  });
});
