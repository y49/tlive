// src/mcp/bundled/web-fetch/server.ts
//
// `web-fetch` bundled MCP server — a single tool `web.fetch(url, opts?)`
// with rate limiting, redirect handling, and content-type negotiation.
// Respects `max_bytes` and `timeout_ms`.

import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

export interface WebFetchOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  rateLimitPerMinute?: number;
}

export interface WebFetchResult {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  redirects: string[];
}

/** In-memory token bucket for simple rate limiting. */
class RateLimiter {
  private timestamps: number[] = [];
  constructor(private perMinute: number) {}
  allow(nowMs = Date.now()): boolean {
    const cutoff = nowMs - 60_000;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    if (this.timestamps.length >= this.perMinute) return false;
    this.timestamps.push(nowMs);
    return true;
  }
}

const defaultLimiter = new RateLimiter(30);

export async function webFetch(url: string, opts: WebFetchOptions = {}, limiter = defaultLimiter): Promise<WebFetchResult> {
  const maxBytes = opts.maxBytes ?? 1_000_000; // 1 MB default
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const method = opts.method ?? 'GET';
  if (!limiter.allow()) throw new Error('rate limit exceeded');

  const redirects: string[] = [];
  let current = url;
  let hops = 0;
  while (true) {
    const parsed = new URL(current);
    const lib = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const reqOpts: RequestOptions = {
      method,
      headers: { 'user-agent': 'tlive-web-fetch/1.0', ...(opts.headers ?? {}) },
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
    };
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const rq = lib(reqOpts, (r) => resolve(r));
      rq.setTimeout(timeoutMs, () => { rq.destroy(new Error(`timeout ${timeoutMs}ms`)); });
      rq.on('error', reject);
      if (opts.body) rq.write(opts.body);
      rq.end();
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      redirects.push(current);
      current = new URL(res.headers.location, current).toString();
      res.resume();
      hops += 1;
      if (hops > maxRedirects) throw new Error(`too many redirects (${hops})`);
      continue;
    }
    const contentType = (res.headers['content-type'] as string) || 'application/octet-stream';
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          truncated = true;
          res.destroy();
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    const body = Buffer.concat(chunks).toString('utf8');
    return { status, contentType, body, truncated, redirects };
  }
}

/** Factory for the bundled MCP tool registration. */
export function makeWebFetchTool() {
  return {
    definition: {
      name: 'web.fetch',
      description: 'Fetch a URL with rate limiting + redirect handling. Returns body + contentType.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'HEAD', 'POST'] },
          headers: { type: 'object' },
          body: { type: 'string' },
          max_bytes: { type: 'number' },
          timeout_ms: { type: 'number' },
        },
        required: ['url'],
      },
    },
    async handler(args: Record<string, unknown>) {
      const url = String(args.url);
      const result = await webFetch(url, {
        method: args.method as WebFetchOptions['method'],
        headers: args.headers as Record<string, string> | undefined,
        body: args.body as string | undefined,
        maxBytes: args.max_bytes as number | undefined,
        timeoutMs: args.timeout_ms as number | undefined,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  };
}
