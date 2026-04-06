import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { CoreClientImpl } from '../core-client.js';

let server: Server;
let port: number;
const TOKEN = 'test-token';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://localhost`);

    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'running', uptime: 10, port: 4590, sessions: 1, version: '0.1.0' }));
    } else if (req.method === 'GET' && url.pathname === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 'sess1', command: 'bash', status: 'running' }]));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>(resolve => {
    server.listen(0, () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterAll(() => server.close());

describe('CoreClientImpl', () => {
  it('connects by checking /api/status', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    expect(client.isHealthy()).toBe(true);
    await client.disconnect();
  });

  it('lists sessions', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess1');
    await client.disconnect();
  });

  it('returns base URL', () => {
    const client = new CoreClientImpl('http://localhost:9999', TOKEN);
    expect(client.getBaseUrl()).toBe('http://localhost:9999');
  });

  it('reports unhealthy when server unreachable', async () => {
    const client = new CoreClientImpl('http://localhost:1', TOKEN);
    try { await client.connect(); } catch {}
    expect(client.isHealthy()).toBe(false);
  });

  it('disconnect stops health checks', async () => {
    const client = new CoreClientImpl(`http://localhost:${port}`, TOKEN);
    await client.connect();
    expect(client.isHealthy()).toBe(true);
    await client.disconnect();
    expect(client.isHealthy()).toBe(false);
  });
});
