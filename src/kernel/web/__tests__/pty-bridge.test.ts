// src/kernel/web/__tests__/pty-bridge.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as net from 'node:net';
import { bridge } from '../pty-bridge.js';
import { SessionHost } from '../../pty/session-host.js';
import { FrameDecoder, FrameType, encodeAttach, encodeData, encodeSize, parseDims } from '../stream-protocol.js';

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  send(d: Buffer): void { this.sent.push(Buffer.from(d)); }
  close(): void { this.readyState = 3; this.emit('close'); }
}

describe('PtyBridge', () => {
  it('pumps bytes both ways between a ws and a session socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-bridge-'));
    const sockPath = join(dir, 's.sock');
    const host = new SessionHost({
      id: 'b1', cmd: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: dir, sockPath, attachLocal: false,
    });
    await host.start();

    const ws = new FakeWs();
    const b = bridge(ws as never, sockPath);

    // give the bridge's net.connect a moment, then drive input through the ws
    await new Promise((r) => setTimeout(r, 100));
    ws.emit('message', encodeAttach(80, 24));
    ws.emit('message', encodeData(Buffer.from('ping\n')));

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no echo')), 8000);
      const dec = new FrameDecoder();
      const iv = setInterval(() => {
        for (const f of dec.push(ws.sent.length ? Buffer.concat(ws.sent.splice(0)) : Buffer.alloc(0))) {
          if (f.type === FrameType.Data && f.payload.toString('utf8').includes('ping')) {
            clearTimeout(t); clearInterval(iv); resolve();
          }
        }
      }, 20);
    });

    b.close();
    await host.stop();
    expect(true).toBe(true);
  });

  it('passes a server→client Size frame through to the ws untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-bridge-size-'));
    const sockPath = join(dir, 'size.sock');

    // Stand up a minimal unix socket server that sends a Size frame on connect.
    const server = net.createServer((sock) => {
      sock.write(encodeSize(120, 40));
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const ws = new FakeWs();
    const b = bridge(ws as never, sockPath);

    // Wait until the fake ws accumulates at least the Size frame bytes.
    const sent = encodeSize(120, 40);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: Size frame not received')), 5000);
      const iv = setInterval(() => {
        const total = ws.sent.reduce((n, b) => n + b.length, 0);
        if (total >= sent.length) { clearTimeout(t); clearInterval(iv); resolve(); }
      }, 20);
    });

    const got = Buffer.concat(ws.sent);
    const frames = new FrameDecoder().push(got);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(FrameType.Size);
    expect(parseDims(frames[0].payload)).toEqual({ cols: 120, rows: 40 });

    b.close();
    server.close();
  });
});
