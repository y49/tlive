// src/ipc.ts
import { createServer, connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const IPC_PATH = join(homedir(), '.tlive', 'ipc.sock');

export interface IPCMessage {
  type: 'permission_action' | 'notification' | 'session_status';
  payload: Record<string, unknown>;
}

export class IPCServer extends EventEmitter {
  private server: ReturnType<typeof createServer> | null = null;
  private clients = new Set<Socket>();

  start(): void {
    if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);
    this.server = createServer((socket) => {
      this.clients.add(socket);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { this.emit('message', JSON.parse(line) as IPCMessage, socket); }
          catch { /* skip malformed JSON */ }
        }
      });
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
    });
    this.server.listen(IPC_PATH);
  }

  broadcast(msg: IPCMessage): void {
    const line = JSON.stringify(msg) + '\n';
    for (const client of this.clients) client.write(line);
  }

  stop(): void {
    for (const client of this.clients) client.destroy();
    this.server?.close();
    if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);
  }
}

export class IPCClient extends EventEmitter {
  private socket: Socket | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = connect(IPC_PATH, () => resolve());
      this.socket.on('error', reject);
      let buffer = '';
      this.socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { this.emit('message', JSON.parse(line) as IPCMessage); }
          catch { /* skip malformed JSON */ }
        }
      });
    });
  }

  send(msg: IPCMessage): void { this.socket?.write(JSON.stringify(msg) + '\n'); }
  disconnect(): void { this.socket?.destroy(); }
}
