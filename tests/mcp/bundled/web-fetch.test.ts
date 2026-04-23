// tests/mcp/bundled/web-fetch.test.ts
//
// Exercise web-fetch against a local http server. Covers redirect + byte cap.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { webFetch, makeWebFetchTool } from '../../../src/mcp/bundled/web-fetch/server.js';

describe('web-fetch bundled MCP', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { location: '/target' });
        res.end();
        return;
      }
      if (req.url === '/target') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('target');
        return;
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('x'.repeat(10_000));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('fetches a simple URL', async () => {
    const r = await webFetch(`${url}/hi`);
    expect(r.status).toBe(200);
    expect(r.body).toBe('hello');
  });

  it('follows a redirect', async () => {
    const r = await webFetch(`${url}/redir`);
    expect(r.body).toBe('target');
    expect(r.redirects).toHaveLength(1);
  });

  it('truncates at max_bytes', async () => {
    const r = await webFetch(`${url}/big`, { maxBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBeLessThanOrEqual(2000);
  });

  it('rate limiter rejects beyond cap', async () => {
    const first = await webFetch(`${url}/hi`);
    expect(first.status).toBe(200);
    // Directly call with a limiter that starts exhausted
    const { webFetch: wf } = await import('../../../src/mcp/bundled/web-fetch/server.js');
    let threw = false;
    try {
      await wf(`${url}/hi`, {}, { allow: () => false } as never);
    } catch (err) {
      threw = /rate limit/.test((err as Error).message);
    }
    expect(threw).toBe(true);
  });

  it('tool definition has correct shape', () => {
    const tool = makeWebFetchTool();
    expect(tool.definition.name).toBe('web.fetch');
    expect(tool.definition.inputSchema.required).toContain('url');
  });
});
