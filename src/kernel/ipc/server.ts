// src/kernel/ipc/server.ts

import { createServer, connect, type Server, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { isPipePath } from './client.js';
import type { IpcRequest, IpcResponse } from './protocol.js';

export interface IpcCallContext {
  callerPid?: number;
  /** 注册"调用方断开连接时叫我"。用于感知 shim 异常死亡(会话被 Ctrl+C /
   *  终端关闭):正常流程下 shim 是拿到决策才关连接,那时 pending 已被
   *  answer()/cancel() 删除 —— 所以"close 时 pending 尚存"零误判地等于
   *  异常死亡,不需要任何超时/探活/心跳。 */
  onDisconnect?: (cb: () => void) => void;
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
    const timer = setTimeout(() => done(false), 500);
    timer.unref();
    const done = (alive: boolean): void => {
      clearTimeout(timer);
      c.destroy();
      resolve(alive);
    };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
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
    const disconnectCbs: Array<() => void> = [];
    sock.on('close', () => {
      for (const cb of disconnectCbs.splice(0)) {
        try { cb(); } catch { /* 一个回调抛出不得影响其它 */ }
      }
    });
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
          const ctx: IpcCallContext = { onDisconnect: (cb) => { disconnectCbs.push(cb); } };
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
    const onError = (e: NodeJS.ErrnoException): void => {
      reject(e.code === 'EADDRINUSE' ? new AlreadyRunningError() : e);
    };
    server.once('error', onError);
    server.listen(opts.path, () => {
      // once() only detaches when the event fires — remove it on success so a
      // later runtime 'error' isn't silently swallowed by this stale listener.
      server.removeListener('error', onError);
      resolve();
    });
  });
  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!isPipePath(opts.path) && existsSync(opts.path)) unlinkSync(opts.path);
    },
  };
}
