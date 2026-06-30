import { describe, it, expect } from 'vitest';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionHost, computeSize } from '../session-host';
import { FrameDecoder, FrameType, encodeAttach, encodeData } from '../../web/stream-protocol.js';

describe('computeSize', () => {
  it('defaults to 80x24 with no dims', () => {
    expect(computeSize([])).toEqual({ cols: 80, rows: 24 });
  });
  it('takes the min across attached dims', () => {
    expect(computeSize([{ cols: 120, rows: 40 }, { cols: 80, rows: 24 }])).toEqual({ cols: 80, rows: 24 });
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
});
