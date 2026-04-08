// src/core/webTerminal.ts
import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WebTerminalOptions {
  port: number;
  token?: string;
  webDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

export class WebTerminal {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private token?: string;
  private webDir: string;
  private onInput?: (data: string) => void;
  private onResize?: (cols: number, rows: number) => void;

  constructor(opts: WebTerminalOptions) {
    this.token = opts.token;
    const __dirname = dirname(fileURLToPath(import.meta.url));
    this.webDir = opts.webDir ?? join(__dirname, '../../web');

    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);

      // Token check for HTML pages
      if (this.token && url.pathname === '/') {
        if (url.searchParams.get('token') !== this.token) {
          res.writeHead(403);
          res.end('Unauthorized');
          return;
        }
      }

      // Serve terminal.html as the main page
      let filePath: string;
      if (url.pathname === '/' || url.pathname === '/index.html') {
        filePath = join(this.webDir, 'terminal.html');
      } else {
        const safe = url.pathname.replace(/\.\./g, '');
        filePath = join(this.webDir, safe);
      }

      if (existsSync(filePath)) {
        const ext = extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
        res.end(readFileSync(filePath));
      } else {
        res.writeHead(404);
        res.end('Not found');
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
      ws.on('message', (raw) => {
        const data = raw.toString();
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'resize' && msg.cols && msg.rows) {
            this.onResize?.(msg.cols, msg.rows);
            return;
          }
        } catch { /* not JSON, terminal input */ }
        this.onInput?.(data);
      });
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  setInputHandler(handler: (data: string) => void): void { this.onInput = handler; }
  setResizeHandler(handler: (cols: number, rows: number) => void): void { this.onResize = handler; }

  broadcast(data: string): void {
    const buf = Buffer.from(data);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(buf);
    }
  }

  sendControl(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
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
    this.sendControl({ type: 'exit', code: 0 });
    for (const ws of this.clients) ws.close();
    this.wss.close();
    this.httpServer.close();
  }
}
