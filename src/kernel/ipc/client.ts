// src/kernel/ipc/client.ts

import { createConnection } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IpcRequest, IpcResponse } from './protocol.js';

export function defaultSocketPath(): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\tlive-daemon';
  return join(process.env.TLIVE_HOME ?? join(homedir(), '.tlive'), 'daemon.sock');
}

/** Per-session pty socket endpoint. Windows has no unix sockets — use a named
 *  pipe (not a filesystem path; exists/unlink/chmod don't apply there). */
export function sessionSocketPath(home: string, id: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\tlive-session-${id}`;
  return join(home, 'sessions', `${id}.sock`);
}

/** True when the endpoint is a Windows named pipe (skip fs ops on it). */
export function isPipePath(p: string): boolean {
  return p.startsWith('\\\\.\\pipe\\');
}

export interface IpcRequestOpts {
  socketPath?: string;
  timeoutMs?: number;
}

export async function request(req: IpcRequest, opts: IpcRequestOpts = {}): Promise<IpcResponse> {
  const path = opts.socketPath ?? defaultSocketPath();
  const timeout = opts.timeoutMs ?? 4000;
  return new Promise<IpcResponse>((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('ipc timeout')); }, timeout);
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, idx)) as IpcResponse);
      } catch (e) { reject(e as Error); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
