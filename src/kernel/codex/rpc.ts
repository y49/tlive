// src/kernel/codex/rpc.ts
//
// Codex app-server 的 JSON-RPC over WebSocket(unix socket)客户端。
// 连接参数是真机探针钉死的:ws+unix 单斜杠格式 + perMessageDeflate:false +
// Host 头缺一不可(tungstenite 否则拒握手)。传输可注入,测试全走 fake。
import { WebSocket } from 'ws';

export interface CodexRpcEvents {
  onNotify: (method: string, params: unknown) => void;
  onServerRequest: (id: number | string, method: string, params: unknown, respond: (result: unknown) => void) => void;
  onClose: () => void;
}
export interface CodexRpc {
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

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
  sock.on('close', () => {
    for (const [, p] of pending) p.reject(new Error('connection closed'));
    pending.clear();
    opts.events.onClose();
  });
  sock.on('error', () => { /* close 事件负责收尾 */ });

  await new Promise<void>((resolve, reject) => {
    sock.once('open', () => {
      call('initialize', {
        clientInfo: { name: 'tlive', title: 'tlive companion', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      }).then(() => resolve(), reject);
    });
    sock.once('error', (e: Error) => reject(e));
  });
  send({ jsonrpc: '2.0', method: 'initialized' });

  return { call, notify: (method, params) => send({ jsonrpc: '2.0', method, params }), close: () => sock.close() };
}
