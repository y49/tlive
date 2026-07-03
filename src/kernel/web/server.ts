// src/kernel/web/server.ts
//
// Daemon web server: http (static + /api/sessions) + ws /ws/term/<id>, single token.
// On a valid ?token= the response sets an httpOnly cookie so the token leaves the URL.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import type { SessionRegistry } from './session-registry.js';
import { bridge } from './pty-bridge.js';
import { type EventHub, type EventClient, type EventAction, parseEventAction } from './event-hub.js';

export interface WebServerOpts {
  bind: string;
  port: number;
  token: string;
  sessions: SessionRegistry;
  events?: EventHub;
  /** Handle an upstream action from a /ws/events client (approve/reply/mute). */
  onAction?: (action: EventAction) => void;
  webDir: string;
}
export interface WebServerHandle { url: string; port: number; close(): Promise<void> }

const MIME: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.map': 'application/json' };

function tokenFromReq(url: URL, req: IncomingMessage): string | null {
  const q = url.searchParams.get('token');
  if (q) return q;
  const cookie = req.headers.cookie ?? '';
  const m = cookie.match(/(?:^|;\s*)tlive_token=([^;]+)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

export async function startWebServer(opts: WebServerOpts): Promise<WebServerHandle> {
  const http = createServer((req, res) => handleHttp(req, res, opts));
  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${opts.bind}`);
    if (tokenFromReq(url, req) !== opts.token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    if (url.pathname === '/ws/events') {
      if (!opts.events) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      const hub = opts.events;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = ws as unknown as EventClient;
        hub.add(client);
        if (opts.onAction) {
          ws.on('message', (data) => {
            const action = parseEventAction(data.toString());
            if (action) opts.onAction!(action);
          });
        }
        ws.on('close', () => hub.remove(client));
        ws.on('error', () => hub.remove(client));
      });
      return;
    }
    const m = url.pathname.match(/^\/ws\/term\/(.+)$/);
    if (!m) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    const session = opts.sessions.get(decodeURIComponent(m[1]));
    if (!session?.sockPath) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const sockPath = session.sockPath;
    wss.handleUpgrade(req, socket, head, (ws) => { bridge(ws as never, sockPath); });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.bind, () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const displayHost = opts.bind === '0.0.0.0' || opts.bind === '::' ? '127.0.0.1' : opts.bind;
  return {
    url: `http://${displayHost}:${port}/?token=${opts.token}`,
    port,
    async close() {
      wss.close();
      await new Promise<void>((r) => { http.close(() => r()); http.closeAllConnections?.(); });
    },
  };
}

function handleHttp(req: IncomingMessage, res: ServerResponse, opts: WebServerOpts): void {
  const url = new URL(req.url ?? '/', `http://${opts.bind}`);
  const tok = tokenFromReq(url, req);
  if (tok !== opts.token) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return; }
  // first ?token= match → set httpOnly cookie so the token leaves the URL
  const setCookie = url.searchParams.get('token') === opts.token
    ? { 'Set-Cookie': `tlive_token=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/` }
    : {};

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...setCookie });
    res.end(JSON.stringify(opts.sessions.list()));
    return;
  }

  // /s/<id> → the terminal SPA (the page reads <id> + token from the URL)
  if (url.pathname.startsWith('/s/')) {
    const page = join(opts.webDir, 'terminal.html');
    if (existsSync(page)) {
      res.writeHead(200, { 'Content-Type': 'text/html', ...setCookie });
      res.end(readFileSync(page));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...setCookie });
      res.end('terminal UI not built (run: npm run build)');
    }
    return;
  }

  // / → the dashboard SPA (session cards + upstream actions over /ws/events)
  let rel = url.pathname === '/' ? '/dashboard.html' : url.pathname;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(opts.webDir, rel);
  if (!filePath.startsWith(normalize(opts.webDir) + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream', ...setCookie });
    res.end(readFileSync(filePath));
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', ...setCookie });
    res.end('<!doctype html><meta charset=utf-8><title>tlive</title><body style="font-family:system-ui;padding:2rem"><h2>tlive web</h2><p>Dashboard UI not built (run: npm run build). API: <code>/api/sessions</code>.</p>');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain', ...setCookie });
  res.end('Not found');
}
