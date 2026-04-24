// src/daemon/health.ts
//
// Local HTTP /health endpoint (spec DoD §9.x).
//
// Exposes a minimal JSON endpoint for `tlive doctor` (T11) and the Claude
// skill bridge to verify daemon liveness + subsystem status without opening
// the IPC socket. Bound to 127.0.0.1 only.
//
// Response body:
//   { daemon: "ok", uptimeMs, sessionCount, warmPoolCount, apiHealth }

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionManager } from '../session/manager.js';
import type { WarmRuntimePool } from '../session/warm-pool.js';

export interface HealthServerOptions {
  port: number;
  sessions: SessionManager;
  warmPool?: WarmRuntimePool;
  startedAt?: number;
}

export interface HealthServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

export async function startHealthServer(opts: HealthServerOptions): Promise<HealthServerHandle> {
  const startedAt = opts.startedAt ?? Date.now();
  const server: HttpServer = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const sessionCount = opts.sessions.listInfo().length;
      const warmPoolCount = (opts.warmPool as unknown as { size?: number })?.size ?? 0;
      const body = JSON.stringify({
        daemon: 'ok',
        uptimeMs: Date.now() - startedAt,
        sessionCount,
        warmPoolCount,
        apiHealth: 'unknown',
        pid: process.pid,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });

  const addr = server.address() as AddressInfo;

  return {
    port: addr.port,
    async close() { await new Promise<void>((r) => server.close(() => r())); },
  };
}
