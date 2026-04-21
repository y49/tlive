// src/cli/ipc-client-lite.ts
//
// Tiny CLI helper: ensure bridge daemon is running, open a single IPC
// request/response cycle, return the response. Used by every new
// subcommand so they stay under ~30 LOC each.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IPCClient, IPCClientRequester, IPC_PATH_V1 } from '../ipc.js';
import type { IPCRequest, IPCResponse } from '../ipc-protocol.js';

const TLIVE_HOME = join(homedir(), '.tlive');
const BRIDGE_PID = join(TLIVE_HOME, 'runtime', 'bridge.pid');

/** Resolve bridge entry — mirrors scripts/cli.js lookup. */
function bridgeEntry(): string {
  // src bundled to dist/src/; package root is two levels up from there.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'bridge', 'dist', 'main.mjs');
}

function bridgeIsAlive(): boolean {
  if (!existsSync(BRIDGE_PID)) return false;
  const pid = parseInt(readFileSync(BRIDGE_PID, 'utf-8').trim(), 10);
  if (isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function ensureDaemonRunning(): Promise<void> {
  if (bridgeIsAlive()) return;
  const entry = bridgeEntry();
  if (!existsSync(entry)) {
    throw new Error(`Bridge not built at ${entry}. Run: npm run build:all`);
  }
  // Route daemon stdout/stderr to ~/.tlive/logs/bridge.log so `tlive logs`
  // can surface auto-start failures instead of silently discarding them.
  const logDir = join(TLIVE_HOME, 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join(logDir, 'bridge.log'), 'a');
  const child = spawn(process.execPath, [entry], {
    detached: true, stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  // Give the daemon up to ~6s to bind the IPC socket.
  // (exponential backoff: 200+400+800+1600+3200 = 6.2s over 5 retries)
  const client = new IPCClient({ path: IPC_PATH_V1, maxRetries: 5, retryDelay: 200, autoReconnect: false });
  const ok = await client.connect();
  client.disconnect();
  if (!ok) throw new Error('Daemon failed to start within ~6s. Check: tlive logs');
}

export async function sendRequest(req: IPCRequest): Promise<IPCResponse> {
  let client = new IPCClient({ path: IPC_PATH_V1, maxRetries: 3, retryDelay: 200, autoReconnect: false });
  let ok = await client.connect();
  if (!ok) {
    // Stale PID file? Retry once after re-ensuring daemon.
    client.disconnect();
    try { unlinkSync(BRIDGE_PID); } catch { /* already gone */ }
    await ensureDaemonRunning();
    client = new IPCClient({ path: IPC_PATH_V1, maxRetries: 3, retryDelay: 200, autoReconnect: false });
    ok = await client.connect();
  }
  if (!ok) throw new Error('Failed to connect to daemon IPC after retry');
  try {
    const requester = new IPCClientRequester(client);
    return await requester.request(req);
  } finally {
    client.disconnect();
  }
}
