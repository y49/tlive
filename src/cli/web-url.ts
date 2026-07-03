// src/cli/web-url.ts
//
// Resolve the daemon web endpoint (from config + token file) into displayable
// URLs: a local one and, when bound beyond loopback, a LAN one for phones.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { loadConfig } from '../kernel/config/loader.js';

export interface WebUrls {
  enabled: boolean;
  local?: string;
  network?: string;
  /** Append to a base URL to open a specific page, e.g. sessionPath(id). */
  token?: string;
}

export function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

export function resolveWebUrls(home: string): WebUrls {
  const cfg = loadConfig(home);
  if (cfg.web?.enabled === false) return { enabled: false };
  const bind = cfg.web?.bind ?? '0.0.0.0';
  const port = cfg.web?.port ?? 7681;
  let token: string | undefined;
  try { token = readFileSync(join(home, 'web-token'), 'utf8').trim() || undefined; } catch { /* first start */ }
  const q = token ? `?token=${token}` : '';
  const out: WebUrls = { enabled: true };
  if (token) out.token = token;
  out.local = `http://localhost:${port}/${q}`;
  if (bind === '0.0.0.0' || bind === '::') {
    const ip = lanIPv4();
    if (ip) out.network = `http://${ip}:${port}/${q}`;
  } else if (bind !== '127.0.0.1' && bind !== 'localhost') {
    out.network = `http://${bind}:${port}/${q}`;
  }
  return out;
}
