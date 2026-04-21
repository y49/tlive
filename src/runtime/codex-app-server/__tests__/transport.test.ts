import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { StdioJsonlTransport } from '../transport.js';

function mockChild(stdout: Readable, stdin: Writable) {
  const ee = new EventEmitter() as EventEmitter & { stdout: Readable; stdin: Writable; kill: ReturnType<typeof vi.fn> };
  ee.stdout = stdout;
  ee.stdin = stdin;
  ee.kill = vi.fn();
  return ee as any;
}

describe('StdioJsonlTransport', () => {
  it('parses a complete JSON line', async () => {
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    const child = mockChild(stdout, stdin);
    const transport = new StdioJsonlTransport(child);
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));
    stdout.push('{"method":"a","params":{}}\n');
    await new Promise(r => setImmediate(r));
    expect(received).toEqual([{ method: 'a', params: {} }]);
  });

  it('accumulates partial line across chunks', async () => {
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    const child = mockChild(stdout, stdin);
    const transport = new StdioJsonlTransport(child);
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));
    stdout.push('{"method":"a",');
    stdout.push('"params":{}}\n');
    await new Promise(r => setImmediate(r));
    expect(received).toEqual([{ method: 'a', params: {} }]);
  });

  it('splits multiple lines in one chunk', async () => {
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    const child = mockChild(stdout, stdin);
    const transport = new StdioJsonlTransport(child);
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));
    stdout.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    await new Promise(r => setImmediate(r));
    expect(received).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('handles UTF-8 multi-byte character across chunk boundary', async () => {
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    const child = mockChild(stdout, stdin);
    const transport = new StdioJsonlTransport(child);
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));
    const buf = Buffer.from('{"t":"中文"}\n', 'utf8');
    stdout.push(buf.subarray(0, 7));
    stdout.push(buf.subarray(7));
    await new Promise(r => setImmediate(r));
    expect(received).toEqual([{ t: '中文' }]);
  });

  it('emits onError for invalid JSON line but continues reading', async () => {
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    const child = mockChild(stdout, stdin);
    const transport = new StdioJsonlTransport(child);
    const received: unknown[] = [];
    const errors: Error[] = [];
    transport.onMessage((m) => received.push(m));
    transport.onError((e) => errors.push(e));
    stdout.push('not json\n{"valid":1}\n');
    await new Promise(r => setImmediate(r));
    expect(errors).toHaveLength(1);
    expect(received).toEqual([{ valid: 1 }]);
  });

  it('writes a JSON object followed by newline to stdin', () => {
    const writes: Buffer[] = [];
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(c, _e, cb) { writes.push(c); cb(); } });
    const child = mockChild(stdout, stdin);
    const transport = new StdioJsonlTransport(child);
    transport.sendMessage({ hello: 'world' });
    expect(Buffer.concat(writes).toString('utf8')).toBe('{"hello":"world"}\n');
  });

  it('close resolves when child exits cleanly', async () => {
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    const child = mockChild(stdout, stdin);
    const transport = new StdioJsonlTransport(child);
    const closePromise = transport.close(1000);
    child.emit('exit', 0, null);
    const result = await closePromise;
    expect(result.code).toBe(0);
  });

  it('close escalates to SIGTERM when child does not exit', async () => {
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    const child = mockChild(stdout, stdin);
    const transport = new StdioJsonlTransport(child);
    const closePromise = transport.close(50);
    await new Promise(r => setTimeout(r, 80));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    await closePromise;
  });
});
