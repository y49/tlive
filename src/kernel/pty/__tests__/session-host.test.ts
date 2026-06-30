import { describe, it, expect } from 'vitest';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionHost, authoritativeSize } from '../session-host';
import { FrameDecoder, FrameType, encodeAttach, encodeData, encodeResize, parseDims } from '../../web/stream-protocol.js';

describe('authoritativeSize', () => {
  it('defaults to 80x24 with no sources', () => {
    expect(authoritativeSize([])).toEqual({ cols: 80, rows: 24 });
  });
  it('ignores sources with no known size (cols/rows 0)', () => {
    expect(authoritativeSize([{ cols: 0, rows: 0, lastInputSeq: 5 }])).toEqual({ cols: 80, rows: 24 });
  });
  it('picks the source with the highest lastInputSeq (last typer wins)', () => {
    expect(authoritativeSize([
      { cols: 80, rows: 24, lastInputSeq: 1 },
      { cols: 120, rows: 40, lastInputSeq: 2 },
    ])).toEqual({ cols: 120, rows: 40 });
  });
  it('on a tie prefers the local TTY', () => {
    expect(authoritativeSize([
      { cols: 120, rows: 40, lastInputSeq: 0 },
      { cols: 80, rows: 24, lastInputSeq: 0, isLocal: true },
    ])).toEqual({ cols: 80, rows: 24 });
  });
});

describe('SessionHost (socket-only, attachLocal:false)', () => {
  it('forwards client input into the pty and fans pty output back as data frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-host-'));
    const sockPath = join(dir, 's.sock');
    // cross-platform echoer: node piping stdin → stdout
    const host = new SessionHost({
      id: 't1',
      cmd: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: dir,
      sockPath,
      attachLocal: false,
    });
    await host.start();

    const received: Buffer[] = [];
    const dec = new FrameDecoder();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for echo')), 8000);
      const sock = createConnection(sockPath, () => {
        sock.write(encodeAttach(80, 24));
        sock.write(encodeData(Buffer.from('hello\n')));
      });
      sock.on('error', reject);
      sock.on('data', (chunk: Buffer) => {
        for (const f of dec.push(chunk)) {
          if (f.type === FrameType.Data) {
            received.push(f.payload);
            if (Buffer.concat(received).toString('utf8').includes('hello')) { clearTimeout(t); sock.end(); resolve(); }
          }
        }
      });
    });

    expect(Buffer.concat(received).toString('utf8')).toContain('hello');
    await host.stop();
  });

  it('pty size follows the last client that typed and broadcasts it to all clients', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-host-'));
    const sockPath = join(dir, 's.sock');
    // quiet pty: reads stdin (so input is consumed) but never echoes; stays alive.
    const host = new SessionHost({
      id: 't2', cmd: process.execPath,
      args: ['-e', 'process.stdin.resume();setInterval(()=>{},1<<30)'],
      cwd: dir, sockPath, attachLocal: false,
    });
    await host.start();

    // Wait until a given client's decoder has seen a Size frame matching {cols,rows}.
    const waitForSize = (sock: ReturnType<typeof createConnection>, dec: FrameDecoder, cols: number, rows: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for Size ${cols}x${rows}`)), 8000);
        sock.on('data', (chunk: Buffer) => {
          for (const f of dec.push(chunk)) {
            if (f.type === FrameType.Size) {
              const d = parseDims(f.payload);
              if (d.cols === cols && d.rows === rows) { clearTimeout(t); resolve(); }
            }
          }
        });
        sock.on('error', reject);
      });

    const decA = new FrameDecoder();
    const decB = new FrameDecoder();
    const a = createConnection(sockPath);
    const b = createConnection(sockPath);
    await new Promise<void>((r) => a.on('connect', () => r()));
    await new Promise<void>((r) => b.on('connect', () => r()));

    a.write(encodeAttach(80, 24));
    b.write(encodeAttach(120, 40));

    // B types → B (120x40) becomes authoritative → both clients get Size 120x40.
    const aGets = waitForSize(a, decA, 120, 40);
    const bGets = waitForSize(b, decB, 120, 40);
    b.write(encodeData(Buffer.from('x')));
    await Promise.all([aGets, bGets]);

    // A types → A (80x24) becomes authoritative → broadcast 80x24.
    const aGets2 = waitForSize(a, decA, 80, 24);
    a.write(encodeData(Buffer.from('y')));
    await aGets2;

    a.end(); b.end();
    await host.stop();
  });
});
