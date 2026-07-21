import { describe, it, expect } from 'vitest';
import { daemonSocketPath, isPipePath } from '../client';

describe('daemonSocketPath', () => {
  it('posix: a filesystem socket inside home', () => {
    expect(daemonSocketPath('/home/u/.tlive', 'linux')).toBe('/home/u/.tlive/daemon.sock');
  });

  it('win32: a named pipe scoped by home — two homes never share a pipe', () => {
    const a = daemonSocketPath('C:\\Users\\a\\.tlive', 'win32');
    const b = daemonSocketPath('C:\\Users\\b\\.tlive', 'win32');
    expect(a).toMatch(/^\\\\\.\\pipe\\tlive-daemon-[0-9a-f]{12}$/);
    expect(isPipePath(a)).toBe(true);
    expect(a).not.toBe(b); // global pipe namespace: per-home scoping is the isolation
    expect(daemonSocketPath('C:\\Users\\a\\.tlive', 'win32')).toBe(a); // deterministic
  });
});
