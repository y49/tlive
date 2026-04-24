// src/ipc/client.ts
//
// Unix-domain-socket IPC client for CLI subcommands.
//
// Reads `~/.tlive/daemon.sock` (override via $TLIVE_SOCKET_PATH) and issues
// a single Envelope<IpcRequest>, yielding a stream of IpcResponse frames for
// that request id. Simple request/response callers use `request()`; the
// streaming `session.logs` kind uses `stream()`.
//
// Connecting with retry is the caller's concern — see `ensureDaemonRunning()`
// which spawns the daemon binary when the socket is absent.

import { connect, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  type Envelope, type IpcRequest, type IpcResponse, encodeFrame, createLineFramer,
} from './protocol.js';

/**
 * Default IPC endpoint. On POSIX (Linux/macOS) this is a filesystem path
 * used as a unix-domain socket. On Windows Node's `net` module requires a
 * named-pipe path (`\\.\pipe\<name>`) for the same IPC semantics; we pick
 * the right shape per platform so users don't have to configure it.
 */
export const DEFAULT_SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\tlive-daemon'
  : join(homedir(), '.tlive', 'daemon.sock');
const DEFAULT_TIMEOUT_MS = 10_000;

export interface IpcClientOptions {
  path?: string;
  timeoutMs?: number;
}

export function getSocketPath(opts: IpcClientOptions = {}): string {
  return opts.path ?? process.env.TLIVE_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
}

/**
 * Issue a single request/response IPC call. Resolves with the first non-
 * streaming response; errors on timeout or transport failure.
 */
export async function request(
  req: IpcRequest,
  opts: IpcClientOptions = {},
): Promise<IpcResponse> {
  const path = getSocketPath(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = randomUUID();

  return new Promise<IpcResponse>((resolve, reject) => {
    const sock = connect(path);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`ipc timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const done = (fn: () => void) => { clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } fn(); };

    const framer = createLineFramer<IpcResponse>((env) => {
      if (env.requestId !== requestId) return;
      done(() => resolve(env.message));
    });

    sock.on('connect', () => {
      sock.write(encodeFrame<IpcRequest>({ requestId, message: req }));
    });
    sock.on('data', (chunk) => framer.push(chunk));
    sock.on('error', (err) => done(() => reject(err)));
    sock.on('close', () => done(() => reject(new Error('ipc connection closed before response'))));
  });
}

/**
 * Issue a streaming request. Caller receives every response frame until
 * the server sends a `logs.end` (or `error`) terminator.
 */
export async function* stream(
  req: IpcRequest,
  opts: IpcClientOptions = {},
): AsyncGenerator<IpcResponse> {
  const path = getSocketPath(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = randomUUID();

  const sock = connect(path);
  const queue: IpcResponse[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;
  let error: Error | null = null;

  const timer = setTimeout(() => {
    if (!finished) { error = new Error(`ipc timeout after ${timeoutMs}ms`); finished = true; resolveNext?.(); sock.destroy(); }
  }, timeoutMs);
  timer.unref?.();

  const framer = createLineFramer<IpcResponse>((env) => {
    if (env.requestId !== requestId) return;
    queue.push(env.message);
    if (env.message.kind === 'logs.end' || env.message.kind === 'error') {
      finished = true;
      sock.destroy();
    }
    resolveNext?.();
  });

  sock.on('connect', () => sock.write(encodeFrame<IpcRequest>({ requestId, message: req })));
  sock.on('data', (c) => framer.push(c));
  sock.on('error', (err) => { error = err as Error; finished = true; resolveNext?.(); });
  sock.on('close', () => { finished = true; resolveNext?.(); });

  try {
    while (true) {
      if (queue.length > 0) {
        const next = queue.shift()!;
        yield next;
        if (next.kind === 'logs.end' || next.kind === 'error') return;
        continue;
      }
      if (finished) {
        if (error) throw error;
        return;
      }
      await new Promise<void>((res) => { resolveNext = res; });
      resolveNext = null;
    }
  } finally {
    clearTimeout(timer);
    try { sock.destroy(); } catch { /* ignore */ }
  }
}

/**
 * Ensure the daemon is running by spawning `dist/src/tlive-daemon.mjs` when
 * the socket is absent or unreachable. Waits up to `timeoutMs` for the
 * socket to appear.
 */
export async function ensureDaemonRunning(opts: IpcClientOptions & { timeoutMs?: number } = {}): Promise<void> {
  const socketPath = getSocketPath(opts);
  if (await canReachSocket(socketPath)) return;

  // Locate the daemon entry — adjacent to this file in dist/src/.
  // When running from source tests, fall back to spawning via tsx — but the
  // production path is the built mjs.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'dist', 'src', 'tlive-daemon.mjs'),
    join(here, '..', '..', '..', 'dist', 'src', 'tlive-daemon.mjs'),
  ];
  const entry = candidates.find(existsSync);
  if (!entry) {
    throw new Error('tlive daemon entry not found (expected dist/src/tlive-daemon.mjs). Run: npm run build');
  }
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  const timeoutMs = opts.timeoutMs ?? 6000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canReachSocket(socketPath)) return;
    await new Promise((r) => setTimeout(r, 100).unref?.());
  }
  throw new Error(`daemon failed to listen at ${socketPath} within ${timeoutMs}ms`);
}

async function canReachSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}
