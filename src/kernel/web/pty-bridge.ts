// src/kernel/web/pty-bridge.ts
//
// Transparent byte pump between a browser ws and a session's per-session socket.
// The stream-protocol is end-to-end (browser ⇄ daemon ⇄ SessionHost), so the
// bridge does NOT parse frames — it just moves bytes, with watermark backpressure.

import { connect, type Socket } from 'node:net';

export interface WsLike {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Buffer): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

const HIGH_WATER = 1 << 20; // 1 MiB queued on the ws → pause the pty socket
const LOW_WATER = 1 << 18;  // 256 KiB → resume

export interface PtyBridge { close(): void }

export function bridge(ws: WsLike, sockPath: string): PtyBridge {
  const sock: Socket = connect(sockPath);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { sock.destroy(); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
  };

  // socket → ws, with backpressure
  sock.on('data', (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk);
    if (ws.bufferedAmount > HIGH_WATER && !sock.isPaused()) {
      sock.pause();
      const tick = (): void => {
        if (closed) return;
        if (ws.bufferedAmount < LOW_WATER) sock.resume();
        else setTimeout(tick, 16).unref();
      };
      setTimeout(tick, 16).unref();
    }
  });
  sock.on('error', close);
  sock.on('close', close);

  // ws → socket
  ws.on('message', (data: unknown) => {
    const buf = Array.isArray(data)
      ? Buffer.concat((data as Buffer[]).map((d) => Buffer.from(d)))
      : Buffer.from(data as Buffer);
    if (sock.writable) sock.write(buf);
  });
  ws.on('close', () => close());
  ws.on('error', () => close());

  return { close };
}
