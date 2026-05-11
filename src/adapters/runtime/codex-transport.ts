// src/adapters/runtime/codex-transport.ts
//
// Thin JSON-RPC client over codex app-server stdio.

import { spawn, type ChildProcess } from 'node:child_process';

export interface CodexTransport {
  request<R = unknown>(method: string, params: unknown): Promise<R>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  close(): Promise<void>;
}

export async function spawnCodexAppServer(opts: { binary?: string }): Promise<CodexTransport> {
  const bin = opts.binary ?? 'codex';
  const child: ChildProcess = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  const pending = new Map<number, (v: unknown) => void>();
  let notifHandler: ((m: string, p: unknown) => void) | undefined;
  let buf = '';

  child.stdout?.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; method?: string; params?: unknown };
        if (typeof msg.id === 'number') {
          pending.get(msg.id)?.(msg.result);
          pending.delete(msg.id);
        } else if (msg.method) {
          notifHandler?.(msg.method, msg.params);
        }
      } catch {}
    }
  });

  return {
    async request(method, params) {
      return new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, (r) => resolve(r as never));
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    onNotification(h) { notifHandler = h; },
    async close() {
      child.stdin?.end();
      await new Promise<void>((r) => child.on('exit', () => r()));
    },
  };
}
