import { describe, it, expect, afterEach } from 'vitest';
import { PTYManager } from '../../src/core/ptyManager.js';

describe('PTYManager', () => {
  let mgr: PTYManager;

  afterEach(async () => {
    if (mgr?.isRunning) await mgr.kill();
  });

  it('spawns a process and receives data', async () => {
    mgr = new PTYManager();
    const chunks: string[] = [];
    mgr.on('data', (d: string) => chunks.push(d));

    mgr.spawn({ command: 'echo', args: ['hello-pty'], cwd: '/tmp' });
    expect(mgr.isRunning).toBe(true);

    await new Promise<void>((resolve) => mgr.on('exit', () => resolve()));
    expect(mgr.isRunning).toBe(false);
    expect(chunks.join('')).toContain('hello-pty');
  });

  it('reports exit code', async () => {
    mgr = new PTYManager();
    mgr.spawn({ command: 'sh', args: ['-c', 'exit 42'], cwd: '/tmp' });
    await new Promise<void>((resolve) => mgr.on('exit', () => resolve()));
    expect(mgr.exitCode).toBe(42);
  });

  it('prevents double spawn', () => {
    mgr = new PTYManager();
    mgr.spawn({ command: 'sleep', args: ['10'], cwd: '/tmp' });
    expect(() => mgr.spawn({ command: 'echo', args: ['x'], cwd: '/tmp' })).toThrow('PTY already running');
  });

  it('kills running process', async () => {
    mgr = new PTYManager();
    mgr.spawn({ command: 'sleep', args: ['999'], cwd: '/tmp' });
    expect(mgr.isRunning).toBe(true);
    await mgr.kill();
    expect(mgr.isRunning).toBe(false);
  });
});
