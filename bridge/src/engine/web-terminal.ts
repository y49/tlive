// bridge/src/engine/web-terminal.ts
//
// HTTP + WebSocket server for the web terminal interface.
// Extracted from terminal-relay.ts.

import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SessionRegistry } from './session-registry.js';

// ---------------------------------------------------------------------------
// MIME types for static file serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// WebTerminal
// ---------------------------------------------------------------------------

export interface WebTerminalDeps {
  port: number;
  token: string;
  webDir: string;
  registry: SessionRegistry;
  log: (msg: string) => void;
}

export class WebTerminal {
  private httpServer: HttpServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private webClients = new Map<string, Set<WebSocket>>();
  private deps: WebTerminalDeps;

  /** Called when a web client sends input — wire this to IPC broadcast. */
  onWebInput: ((sessionId: string, data: string) => void) | null = null;

  constructor(deps: WebTerminalDeps) {
    this.deps = deps;
  }

  start(): void {
    const { port, token, webDir, registry, log } = this.deps;

    this.httpServer = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      // Health check (no auth)
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', sessions: registry.listSessions().length }));
        return;
      }

      // Token check for HTML pages
      const needsAuth = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/terminal.html';
      if (needsAuth && token && url.searchParams.get('token') !== token) {
        res.writeHead(403); res.end('Unauthorized'); return;
      }

      // Session list page
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const sessions = registry.listSessions();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this.renderSessionList(sessions, token));
        return;
      }

      // Serve static files from web/
      if (webDir) {
        const safePath = url.pathname.replace(/\.\./g, '');
        const filePath = join(webDir, safePath);
        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath);
            const mime = MIME[extname(filePath)] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(content);
            return;
          } catch { /* fall through */ }
        }
      }

      res.writeHead(404); res.end('Not found');
    });

    this.wsServer = new WebSocketServer({ server: this.httpServer });
    this.wsServer.on('connection', (ws: WebSocket, req) => {
      const url = new URL(req.url ?? '', `http://localhost:${port}`);
      if (token && url.searchParams.get('token') !== token) {
        ws.close(4001, 'Unauthorized'); return;
      }

      const sessionId = url.searchParams.get('session');
      if (!sessionId || !registry.getSession(sessionId)) {
        ws.close(4002, 'Session not found'); return;
      }

      // Register web client
      if (!this.webClients.has(sessionId)) this.webClients.set(sessionId, new Set());
      this.webClients.get(sessionId)!.add(ws);

      // Web input -> callback -> IPC -> terminal process
      ws.on('message', (raw) => {
        const data = raw.toString();
        this.onWebInput?.(sessionId, data);
      });

      ws.on('close', () => {
        this.webClients.get(sessionId)?.delete(ws);
      });
    });

    this.httpServer.listen(port, () => {
      log(`Web terminal at http://localhost:${port}`);
    });
  }

  stop(): void {
    for (const clients of this.webClients.values()) {
      for (const ws of clients) ws.close();
    }
    this.wsServer?.close();
    this.httpServer?.close();
  }

  /** Forward PTY data from terminal to web clients watching a session. */
  forwardPtyData(sessionId: string, data: string): void {
    const clients = this.webClients.get(sessionId);
    if (clients) {
      const buf = Buffer.from(data);
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(buf);
      }
    }
  }

  /** Clean up web clients for a session (called on session unregister). */
  closeSessionClients(sessionId: string): void {
    const clients = this.webClients.get(sessionId);
    if (clients) {
      for (const ws of clients) ws.close();
      this.webClients.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private renderSessionList(
    sessions: Array<{ sessionId: string; projectName: string; workdir: string }>,
    token: string,
  ): string {
    const tokenParam = token ? `?token=${token}` : '';
    if (sessions.length === 0) {
      return `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:3em">
        <h2>TLive Web Terminal</h2><p>No active sessions</p>
        <p>Start one with: <code>tlive claude</code></p></body></html>`;
    }
    const items = sessions.map(s =>
      `<li><a href="/terminal.html${tokenParam ? tokenParam + '&' : '?'}session=${s.sessionId}">${s.projectName || 'session'} &middot; #${s.sessionId.slice(0, 6)}</a> <small>${s.workdir}</small></li>`
    ).join('');
    return `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2em">
      <h2>TLive Web Terminal</h2><ul style="list-style:none;padding:0">${items}</ul></body></html>`;
  }
}
