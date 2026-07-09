// src/kernel/ipc/server.ts

import { createServer, connect, type Server, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { isPipePath } from './client.js';
import type { IpcRequest, IpcResponse } from './protocol.js';

export interface IpcCallContext {
  callerPid?: number;
}

export interface IpcServer {
  close(): Promise<void>;
}

/** Thrown when another live daemon already owns the target socket. */
export class AlreadyRunningError extends Error {
  constructor() { super('another instance is already listening on the ipc socket'); }
}

/** True iff something is accepting connections on the socket path. */
function isSocketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(path);
    const done = (alive: boolean): void => { c.destroy(); resolve(alive); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}

export async function startIpcServer(opts: {
  path: string;
  handler: (req: IpcRequest, reply: (r: IpcResponse) => void, ctx: IpcCallContext) => void | Promise<void>;
}): Promise<IpcServer> {
  if (!isPipePath(opts.path) && existsSync(opts.path)) {
    // Probe before unlink: a LIVE daemon owns this socket → do not clobber it
    // (unconditional unlink caused split-brain when two daemons raced).
    if (await isSocketAlive(opts.path)) throw new AlreadyRunningError();
    unlinkSync(opts.path); // stale leftover from a dead daemon
  }
  const server: Server = createServer((sock: Socket) => {
    // Suppress EPIPE / ECONNRESET from writes to a disconnected socket.
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line) as IpcRequest;
          const ctx: IpcCallContext = {};
          // Best-effort SO_PEERCRED via raw socket. Linux only.
          // (Skipped here for portability; daemon can read /proc/<pid>/comm later.)
          const reply = (r: IpcResponse) => {
            if (!sock.destroyed) sock.write(JSON.stringify(r) + '\n');
          };
          Promise.resolve(opts.handler(req, reply, ctx)).catch((e) => {
            reply({ kind: 'error', message: (e as Error).message });
          });
        } catch (e) {
          if (!sock.destroyed) sock.write(JSON.stringify({ kind: 'error', message: 'bad-json' }) + '\n');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE' ? new AlreadyRunningError() : e);
    });
    server.listen(opts.path, () => resolve());
  });
  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!isPipePath(opts.path) && existsSync(opts.path)) unlinkSync(opts.path);
    },
  };
}
