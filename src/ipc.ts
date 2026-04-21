// src/ipc.ts
// Newline-delimited JSON IPC between `tlive claude` processes and the bridge daemon.

import { createServer, connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

export const IPC_PATH = join(homedir(), '.tlive', 'ipc.sock');

// Distinct socket path for the typed v1.0 IPC handler (IPCSessionHandler).
// Keeps the legacy TerminalRelay socket (IPC_PATH) and the new typed server
// from colliding on the same file path — both would otherwise unlink/rebind
// each other during bridge startup. T10+ `ipc-client-lite.ts` MUST connect to
// this path (not IPC_PATH). When T13/T14 delete TerminalRelay, this can be
// consolidated back to IPC_PATH.
export const IPC_PATH_V1 = join(homedir(), '.tlive', 'ipc-v1.sock');

export interface IPCMessage {
  type: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared line-protocol parser — extracts newline-delimited JSON from a stream.
// Used by both IPCServer (per-client) and IPCClient.
// ---------------------------------------------------------------------------

function attachLineParser(
  socket: Socket,
  onMessage: (msg: IPCMessage) => void,
): void {
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); }
      catch { /* skip malformed JSON */ }
    }
  });
}

function sendMessage(socket: Socket, msg: IPCMessage): void {
  socket.write(JSON.stringify(msg) + '\n');
}

// ---------------------------------------------------------------------------
// Server — runs inside the bridge daemon.
// ---------------------------------------------------------------------------

export class IPCServer extends EventEmitter {
  private server: ReturnType<typeof createServer> | null = null;
  private clients = new Set<Socket>();
  private activePath: string = IPC_PATH;

  start(path: string = IPC_PATH): void {
    if (existsSync(path)) unlinkSync(path);
    this.activePath = path;

    this.server = createServer((socket) => {
      this.clients.add(socket);
      this.emit('client:connect', socket);

      attachLineParser(socket, (msg) => this.emit('message', msg, socket));

      socket.on('close', () => {
        this.clients.delete(socket);
        this.emit('client:disconnect', socket);
      });
      socket.on('error', () => this.clients.delete(socket));
    });

    this.server.listen(path);
  }

  broadcast(msg: IPCMessage): void {
    for (const client of this.clients) sendMessage(client, msg);
  }

  reply(socket: Socket, msg: IPCMessage): void {
    sendMessage(socket, msg);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  stop(): void {
    for (const client of this.clients) client.destroy();
    this.server?.close();
    try { unlinkSync(this.activePath); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Client — runs inside each `tlive claude` process.
// Supports typed message handlers and auto-reconnect.
// ---------------------------------------------------------------------------

export interface IPCClientOptions {
  /** Max reconnect attempts (0 = no reconnect). Default: 10 */
  maxRetries?: number;
  /** Delay between retries in ms. Default: 500 */
  retryDelay?: number;
  /** IPC socket path. Default: ~/.tlive/ipc.sock */
  path?: string;
  /** Auto-reconnect on disconnect. Default: true */
  autoReconnect?: boolean;
}

export class IPCClient extends EventEmitter {
  private socket: Socket | null = null;
  private _connected = false;
  private opts: Required<IPCClientOptions>;

  constructor(opts: IPCClientOptions = {}) {
    super();
    this.opts = {
      maxRetries: opts.maxRetries ?? 10,
      retryDelay: opts.retryDelay ?? 500,
      path: opts.path ?? IPC_PATH,
      autoReconnect: opts.autoReconnect ?? true,
    };
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the IPC server, retrying until the bridge is ready.
   * Resolves true if connected, false if all retries exhausted.
   */
  async connect(): Promise<boolean> {
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const ok = await this.tryConnect();
      if (ok) {
        if (attempt > 0) this.emit('reconnected');
        return true;
      }
      if (attempt < this.opts.maxRetries) {
        const delay = Math.min(this.opts.retryDelay * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return false;
  }

  private tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(this.opts.path, () => {
        this.socket = socket;
        this._connected = true;
        attachLineParser(socket, (msg) => this.emit(msg.type, msg.payload));
        socket.on('close', () => {
          this._connected = false;
          this.emit('disconnected');
          if (this.opts.autoReconnect) {
            setTimeout(() => this.connect(), this.opts.retryDelay);
          }
        });
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
  }

  /** Send a typed message to the bridge. */
  send(type: string, payload: Record<string, unknown> = {}): void {
    if (this.socket && this._connected) {
      sendMessage(this.socket, { type, payload });
    }
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this._connected = false;
  }
}

// ---------------------------------------------------------------------------
// Typed request/response layer — used by CLI subcommands (tlive list / stop
// / resume / claude / codex). Wraps IPCClient.send('request', ...) with a
// correlated awaitable reply.
// ---------------------------------------------------------------------------

import type { Envelope, IPCRequest, IPCResponse } from './ipc-protocol.js';
import { randomUUID } from 'node:crypto';

export class IPCClientRequester {
  constructor(private readonly client: IPCClient) {}

  async request(req: IPCRequest, timeoutMs = 10_000): Promise<IPCResponse> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.client.off('response', off as (p: unknown) => void);
        reject(new Error(`IPC timeout (${req.type})`));
      }, timeoutMs);
      const off = (payload: { envelope: Envelope<IPCResponse> }) => {
        if (payload.envelope.requestId !== requestId) return;
        clearTimeout(t);
        this.client.off('response', off as (p: unknown) => void);
        resolve(payload.envelope.message);
      };
      this.client.on('response', off as (p: unknown) => void);
      this.client.send('request', { envelope: { requestId, message: req } } as Record<string, unknown>);
    });
  }
}
