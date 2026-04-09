// src/ipc.ts
// Newline-delimited JSON IPC between `tlive claude` processes and the bridge daemon.

import { createServer, connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

export const IPC_PATH = join(homedir(), '.tlive', 'ipc.sock');

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

  start(path: string = IPC_PATH): void {
    if (existsSync(path)) unlinkSync(path);

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
    try { unlinkSync(IPC_PATH); } catch { /* already gone */ }
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
      if (ok) return true;
      if (attempt < this.opts.maxRetries) {
        await new Promise((r) => setTimeout(r, this.opts.retryDelay));
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
