// src/kernel/ipc/server.ts

import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import type { IpcRequest, IpcResponse } from './protocol.js';

export interface IpcCallContext {
  callerPid?: number;
}

export interface IpcServer {
  close(): Promise<void>;
}

export async function startIpcServer(opts: {
  path: string;
  handler: (req: IpcRequest, reply: (r: IpcResponse) => void, ctx: IpcCallContext) => void | Promise<void>;
}): Promise<IpcServer> {
  if (existsSync(opts.path)) unlinkSync(opts.path);
  const server: Server = createServer((sock: Socket) => {
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
            sock.write(JSON.stringify(r) + '\n');
          };
          Promise.resolve(opts.handler(req, reply, ctx)).catch((e) => {
            reply({ kind: 'error', message: (e as Error).message });
          });
        } catch (e) {
          sock.write(JSON.stringify({ kind: 'error', message: 'bad-json' }) + '\n');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.path, () => resolve()));
  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (existsSync(opts.path)) unlinkSync(opts.path);
    },
  };
}
