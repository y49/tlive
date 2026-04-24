// src/ipc/server.ts
//
// Unix-domain-socket IPC server for the daemon (spec §13.6).
//
// The daemon listens at `~/.tlive/daemon.sock` (or an override path) and
// dispatches each incoming Envelope<IpcRequest> to the injected handler.
// The handler is either a single-frame callback (response sent back) or an
// async generator for streaming kinds like `session.logs`.

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  type Envelope, type IpcRequest, type IpcResponse, encodeFrame, createLineFramer,
} from './protocol.js';

export interface IpcServerHandler {
  (req: IpcRequest, reply: (r: IpcResponse) => void): Promise<void>;
}

export interface IpcServerOptions {
  path: string;
  handler: IpcServerHandler;
}

export interface IpcServerHandle {
  readonly path: string;
  close(): Promise<void>;
}

export async function startIpcServer(opts: IpcServerOptions): Promise<IpcServerHandle> {
  await fs.mkdir(dirname(opts.path), { recursive: true });
  if (existsSync(opts.path)) {
    try { unlinkSync(opts.path); } catch { /* stale socket */ }
  }

  const clients = new Set<Socket>();
  const server: NetServer = createServer((sock) => {
    clients.add(sock);
    const framer = createLineFramer<IpcRequest>(async (env) => {
      try {
        await opts.handler(env.message, (response) => {
          if (!sock.writable) return;
          sock.write(encodeFrame<IpcResponse>({ requestId: env.requestId, message: response }));
        });
      } catch (err) {
        if (!sock.writable) return;
        sock.write(encodeFrame<IpcResponse>({
          requestId: env.requestId,
          message: { kind: 'error', message: (err as Error).message ?? String(err) },
        }));
      }
    });
    sock.on('data', (chunk) => framer.push(chunk));
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => { try { sock.destroy(); } catch { /* ignore */ } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.path, () => { server.off('error', reject); resolve(); });
  });

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const sock of clients) { try { sock.destroy(); } catch { /* ignore */ } }
    clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(opts.path); } catch { /* already gone */ }
  }

  return { path: opts.path, close };
}
