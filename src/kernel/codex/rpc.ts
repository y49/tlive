// src/kernel/codex/rpc.ts
//
// Codex app-server 的 JSON-RPC over WebSocket(unix socket)客户端。
// 连接参数是真机探针钉死的:ws+unix 单斜杠格式 + perMessageDeflate:false +
// Host 头缺一不可(tungstenite 否则拒握手)。传输可注入,测试全走 fake。
import { WebSocket } from 'ws';
import { createRequire } from 'node:module';

const pkgVersion: string = (() => {
  try { return (createRequire(import.meta.url)('../../../package.json') as { version: string }).version; } catch { return '0.0.0'; }
})();

export interface CodexRpcEvents {
  onNotify: (method: string, params: unknown) => void;
  onServerRequest: (id: number | string, method: string, params: unknown, respond: (result: unknown) => void) => void;
  onClose: () => void;
}
export interface CodexRpc {
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
  /** The originator this app-server process is actually stamping on threads,
   *  read back from `initialize`'s `userAgent` (`<originator>/<version> …`, see
   *  codex-rs/login/src/auth/default_client.rs `get_codex_user_agent`). We send
   *  a name that must NOT set it (below); this is how we find out if that ever
   *  stops being true. */
  effectiveOriginator?: string;
}

/** Upstream's exemption allowlist, mirrored so the reason is reviewable here:
 *  codex-rs/app-server/src/request_processors/initialize_processor.rs:16. */
export const NON_ORIGINATING_CLIENT_NAMES = ['codex_app_server_daemon', 'codex-backend'] as const;

/** Why not `'tlive'`.
 *
 *  `initialize` calls `set_default_originator(clientInfo.name)`, which writes a
 *  PROCESS-GLOBAL, first-write-wins originator (initialize_processor.rs:112 →
 *  login/src/auth/default_client.rs:86). The companion connects the moment the
 *  daemon starts, so it always wins that race — and from then on every thread
 *  created in that app-server is stamped with our name, including threads the
 *  user opened in their own Codex TUI. Two consequences, both measured:
 *
 *  1. `is_first_party_originator()` accepts `"codex-tui"` and rejects anything
 *     else, and behaviour hangs off it (core/src/mcp_skill_dependencies.rs:42
 *     silently skips the skill MCP-dependency install prompt). Monitoring the
 *     user's sessions must not degrade them.
 *  2. Rollout headers claim `originator: tlive` for sessions tlive never
 *     started, which twice sent an investigation looking for a self-feeding
 *     loop that does not exist.
 *
 *  Clients in `NON_ORIGINATING_CLIENT_NAMES` skip that mutation entirely
 *  (`mutates_global_identity`), which is exactly the contract a watcher wants.
 *  The cost is a borrowed name: upstream's own daemon health-probe client uses
 *  this one (app-server-daemon/src/client.rs:26), so tlive's connection is not
 *  distinguishable from it in app-server traces. `clientInfo.title` still says
 *  tlive, nothing else about the connection changes (`app_server_client_name`
 *  feeds tracing/analytics only — no feature gates), and `effectiveOriginator`
 *  above catches the day the exemption disappears. */
export const COMPANION_CLIENT_NAME = NON_ORIGINATING_CLIENT_NAMES[0];

export function defaultCodexSocket(sockPath: string): WebSocket {
  return new WebSocket(`ws+unix:${sockPath}:/`, { perMessageDeflate: false, headers: { Host: 'localhost' } });
}

export async function connectCodexRpc(opts: {
  sockPath: string;
  events: CodexRpcEvents;
  makeSocket?: () => WebSocket;
}): Promise<CodexRpc> {
  const sock = (opts.makeSocket ?? (() => defaultCodexSocket(opts.sockPath)))();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const send = (obj: unknown): void => { sock.send(JSON.stringify(obj)); };
  const call = (method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs).unref?.();
    });

  sock.on('message', (data: Buffer) => {
    let m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id as number);
      if (!p) return;
      pending.delete(m.id as number);
      m.error ? p.reject(new Error(m.error.message ?? JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method !== undefined && m.id !== undefined) {
      let answered = false;
      opts.events.onServerRequest(m.id, m.method, m.params, (result) => {
        if (answered) return; // 恰好一次
        answered = true;
        send({ jsonrpc: '2.0', id: m.id, result });
      });
      return;
    }
    if (m.method !== undefined) opts.events.onNotify(m.method, m.params);
  });
  sock.on('error', () => { /* handshake rejects; after that, 'close' cleans up */ });

  // Until the handshake completes, a failure is reported ONLY by rejecting this
  // promise — `events.onClose` is deliberately not wired yet. Wiring it here
  // instead gave every failed connect attempt two reports (the rejection AND
  // the close event), and callers that reconnect on both then ran two
  // connect loops in parallel and ended up with two live connections to one
  // app-server, each with handlers attached, so every event was processed twice
  // and every approval requested twice.
  const result = await new Promise<{ userAgent?: unknown }>((resolve, reject) => {
    sock.once('open', () => {
      call('initialize', {
        clientInfo: { name: COMPANION_CLIENT_NAME, title: 'tlive companion', version: pkgVersion },
        capabilities: { experimentalApi: true },
      }).then((r) => resolve((r ?? {}) as { userAgent?: unknown }), reject);
    });
    sock.once('error', (e: Error) => reject(e));
  }).catch((e: unknown) => {
    // A socket left open keeps its 'message' handler installed and goes on
    // delivering events (and approval ServerRequests) on a connection the
    // caller has already given up on.
    sock.close();
    throw e;
  });
  send({ jsonrpc: '2.0', method: 'initialized' });

  sock.on('close', () => {
    for (const [, p] of pending) p.reject(new Error('connection closed'));
    pending.clear();
    opts.events.onClose();
  });

  const ua = typeof result.userAgent === 'string' ? result.userAgent : undefined;
  return {
    call,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    close: () => sock.close(),
    ...(ua ? { effectiveOriginator: ua.split('/')[0] } : {}),
  };
}
