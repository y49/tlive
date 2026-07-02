// src/kernel/daemon/__tests__/session-ipc.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapDaemon, type DaemonHandle } from '../bootstrap';
import { request } from '../../ipc/client';
import type { SessionMeta } from '../../ipc/protocol';

let tmp: string;
let h: DaemonHandle;
let sock: string;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tlive-sess-')); sock = join(tmp, 'daemon.sock'); });
afterEach(async () => { await h?.shutdown(); });

const meta: SessionMeta = { id: 's1', label: 'cat @ tmp', cmd: 'cat', cwd: '/tmp', pid: 123, sockPath: '/tmp/s1.sock' };

describe('session.* over IPC', () => {
  it('registers, lists, and unregisters a wrapped session', async () => {
    h = await bootstrapDaemon({ home: tmp });

    const reg = await request({ kind: 'session.register', session: meta }, { socketPath: sock, timeoutMs: 2000 });
    expect(reg.kind).toBe('ack');

    const listed = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
    expect(listed.kind).toBe('session.list');
    if (listed.kind === 'session.list') {
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0].id).toBe('/tmp');
      expect(listed.sessions[0].sockPath).toBe('/tmp/s1.sock');
    }

    await request({ kind: 'session.unregister', id: 's1' }, { socketPath: sock, timeoutMs: 2000 });
    const after = await request({ kind: 'session.list' }, { socketPath: sock, timeoutMs: 2000 });
    if (after.kind === 'session.list') expect(after.sessions).toHaveLength(0);
  });

  it('exposes the registry on the handle', async () => {
    h = await bootstrapDaemon({ home: tmp });
    h.sessions.register(meta);
    expect(h.sessions.list()).toHaveLength(1);
  });
});
