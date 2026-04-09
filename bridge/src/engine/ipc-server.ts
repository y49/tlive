// bridge/src/engine/ipc-server.ts
//
// IPC server for line-delimited JSON over Unix domain socket.
// Extracted from terminal-relay.ts to isolate socket lifecycle management.

import { createServer, type Socket, type Server } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Line-delimited JSON protocol
// ---------------------------------------------------------------------------

function attachLineParser(socket: Socket, onMessage: (msg: Record<string, unknown>) => void): void {
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch { /* skip */ }
    }
  });
}

/** Send a JSON message to a specific socket (line-delimited). */
export function sendJson(socket: Socket, msg: Record<string, unknown>): void {
  socket.write(JSON.stringify(msg) + '\n');
}

// ---------------------------------------------------------------------------
// IPCServer
// ---------------------------------------------------------------------------

export interface IPCServerEvents {
  message: [payload: Record<string, unknown>, type: string, socket: Socket];
  connect: [socket: Socket];
  disconnect: [socket: Socket];
}

export class IPCServer extends EventEmitter {
  private server: Server | null = null;
  private clients = new Set<Socket>();

  constructor(
    private socketPath: string,
    private log: (msg: string) => void,
  ) {
    super();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  start(): void {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);

    this.server = createServer((socket) => {
      this.clients.add(socket);
      this.log(`Terminal connected (${this.clients.size} active)`);
      this.emit('connect', socket);

      attachLineParser(socket, (msg) => {
        this.emit('message', msg.payload as Record<string, unknown>, msg.type as string, socket);
      });

      socket.on('close', () => {
        this.clients.delete(socket);
        this.emit('disconnect', socket);
        this.log(`Terminal disconnected (${this.clients.size} active)`);
      });

      socket.on('error', () => {
        this.clients.delete(socket);
      });
    });

    this.server.listen(this.socketPath, () => this.log(`IPC listening at ${this.socketPath}`));
  }

  stop(): void {
    for (const client of this.clients) client.destroy();
    this.server?.close();
    try { unlinkSync(this.socketPath); } catch { /* gone */ }
  }

  broadcast(msg: Record<string, unknown>): void {
    for (const client of this.clients) sendJson(client, msg);
  }

  reply(socket: Socket, msg: Record<string, unknown>): void {
    sendJson(socket, msg);
  }
}
