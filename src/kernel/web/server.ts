// src/kernel/web/server.ts
//
// Daemon web server: http (static + /api/sessions) + ws /ws/term/<id>, single token.
// On a valid ?token= the response sets an httpOnly cookie so the token leaves the URL.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
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
  /** Handle an upstream action from a /ws/events client (approve/reply/mute/inject). */
  onAction?: (action: EventAction) => void;
  /** Where POST /api/upload stores files (e.g. ~/.tlive/inbox). Upload 404s when unset. */
  inboxDir?: string;
  webDir: string;
}
export interface WebServerHandle { url: string; port: number; close(): Promise<void> }

const MIME: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.map': 'application/json' };

/** Constant-time token check — the token is the sole auth gate; avoid a timing oracle. */
function tokenValid(got: string | null, want: string): boolean {
  if (got == null) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
    if (!tokenValid(tokenFromReq(url, req), opts.token)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
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
  if (!tokenValid(tok, opts.token)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return; }
  // first ?token= match → set httpOnly cookie so the token leaves the URL
  const setCookie = tokenValid(url.searchParams.get('token'), opts.token)
    ? { 'Set-Cookie': `tlive_token=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/` }
    : {};

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...setCookie });
    res.end(JSON.stringify(opts.sessions.list()));
    return;
  }

  // POST /api/upload?name=<filename> — raw body → inbox file → { path }.
  // Used by paste/drag-drop on the terminal page and the dashboard 📎 button.
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    if (!opts.inboxDir) { res.writeHead(404); res.end('upload disabled'); return; }
    const name = (url.searchParams.get('name') || 'file').replace(/[/\\]/g, '_');
    const MAX = 32 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX) { res.writeHead(413); res.end('too large'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        mkdirSync(opts.inboxDir!, { recursive: true });
        const dest = join(opts.inboxDir!, `${randomUUID().slice(0, 8)}-${name}`);
        writeFileSync(dest, Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: dest }));
      } catch (e) {
        res.writeHead(500); res.end(String((e as Error).message));
      }
    });
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
