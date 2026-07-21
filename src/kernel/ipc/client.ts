// src/kernel/ipc/client.ts

import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IpcRequest, IpcResponse } from './protocol.js';

/** Daemon IPC endpoint for a given tlive home. Windows named pipes live in a
 *  single GLOBAL namespace (no per-user filesystem scoping like ~/.tlive), so
 *  the pipe name is scoped by a hash of `home` — two users on one machine, or
 *  an isolated TLIVE_HOME test env, must never collide on one pipe. The shim
 *  (via defaultSocketPath) and the daemon (via bootstrap's opts.home) both
 *  resolve home as TLIVE_HOME ?? ~/.tlive, so they derive the same name. */
export function daemonSocketPath(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const tag = createHash('sha256').update(home).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\tlive-daemon-${tag}`;
  }
  return join(home, 'daemon.sock');
}

export function defaultSocketPath(): string {
  return daemonSocketPath(process.env.TLIVE_HOME ?? join(homedir(), '.tlive'));
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

/** Thrown when the socket closes (a clean FIN, e.g. the daemon restarting —
 *  or an abrupt reset) before a full reply line arrived. Distinguishable from
 *  the plain timeout Error above so callers/logs can tell "daemon vanished
 *  mid-request" apart from "daemon never answered in time". */
export class IpcConnectionClosedError extends Error {
  constructor(message = 'ipc connection closed before a reply was received') {
    super(message);
    this.name = 'IpcConnectionClosedError';
  }
}

export async function request(req: IpcRequest, opts: IpcRequestOpts = {}): Promise<IpcResponse> {
  const path = opts.socketPath ?? defaultSocketPath();
  const timeout = opts.timeoutMs ?? 4000;
  return new Promise<IpcResponse>((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    let settled = false;

    // A daemon restart delivers a clean FIN — 'end' then 'close' — with no
    // 'error' at all, so 'error' alone can never catch it. 'close' is the one
    // event guaranteed to fire on every path (success, error, or orderly
    // remote shutdown), which is why it — not 'end' — is the backstop here.
    // On the success path this code itself calls sock.end() before resolving,
    // so 'close' still fires afterwards; the `settled` guard is what stops
    // that from re-rejecting an already-resolved promise. Node also always
    // follows 'error' with 'close', so the same guard makes that pairing
    // settle only once, explicitly, rather than by accidental no-op semantics.
    const settleResolve = (value: IpcResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const timer = setTimeout(() => {
      sock.destroy();
      settleReject(new Error('ipc timeout'));
    }, timeout);

    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      sock.end();
      try {
        settleResolve(JSON.parse(buf.slice(0, idx)) as IpcResponse);
      } catch (e) { settleReject(e as Error); }
    });
    sock.on('error', (e) => settleReject(e));
    sock.on('close', () => settleReject(new IpcConnectionClosedError()));
  });
}
