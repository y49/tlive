// src/core/webTerminal.ts
import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WebTerminalOptions {
  port: number;
  token?: string;
}

export class WebTerminal {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private token?: string;
  private onInput?: (data: string) => void;

  constructor(opts: WebTerminalOptions) {
    this.token = opts.token;

    this.httpServer = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        try {
          // Try to serve existing xterm.js frontend from core/web/
          const __dirname = dirname(fileURLToPath(import.meta.url));
          const html = readFileSync(join(__dirname, '../../core/web/index.html'), 'utf-8');
          res.end(html);
        } catch {
          res.end('<h1>TLive Web Terminal</h1><p>Frontend assets not found</p>');
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws, req) => {
      if (this.token) {
        const url = new URL(req.url ?? '', `http://localhost:${opts.port}`);
        if (url.searchParams.get('token') !== this.token) {
          ws.close(4001, 'Unauthorized');
          return;
        }
      }
      this.clients.add(ws);
      ws.on('message', (data) => this.onInput?.(data.toString()));
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  setInputHandler(handler: (data: string) => void): void {
    this.onInput = handler;
  }

  broadcast(data: string): void {
    const buf = Buffer.from(data);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(buf);
    }
  }

  startOnPort(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(port, () => resolve());
    });
  }

  get address(): { port: number } | null {
    const addr = this.httpServer.address();
    if (typeof addr === 'object' && addr) return addr;
    return null;
  }

  stop(): void {
    for (const ws of this.clients) ws.close();
    this.wss.close();
    this.httpServer.close();
  }
}
