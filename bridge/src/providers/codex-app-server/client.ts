import type { StdioJsonlTransport } from './transport.js';

export class CodexAppServerClient {
  private initialized = false;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();

  constructor(private transport: StdioJsonlTransport) {
    this.transport.onMessage((m) => this.onMessage(m));
  }

  async initialize(params: unknown): Promise<unknown> {
    const result = await this.requestRaw('initialize', params, 10000);
    this.initialized = true;
    return result;
  }

  async request<P, R>(method: string, params: P, timeoutMs = 30000): Promise<R> {
    if (!this.initialized) {
      throw new Error(`CodexAppServerClient: must call initialize() before request("${method}")`);
    }
    return this.requestRaw(method, params, timeoutMs) as Promise<R>;
  }

  notify<P>(method: string, params: P): void {
    this.transport.sendMessage({ method, params });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    const existing = this.notificationHandlers.get(method) ?? [];
    existing.push(handler);
    this.notificationHandlers.set(method, existing);
  }

  async close(): Promise<void> {
    // Reject all pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Client closed'));
    }
    this.pending.clear();
    await this.transport.close();
  }

  private async requestRaw(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout after ${timeoutMs}ms (method: ${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.sendMessage({ id, method, params });
    });
  }

  private onMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if ('id' in m && ('result' in m || 'error' in m)) {
      // Response
      const id = m.id as number;
      const p = this.pending.get(id);
      if (!p) {
        console.warn(`[codex-client] Received response for unknown id ${id}, dropping`);
        return;
      }
      this.pending.delete(id);
      clearTimeout(p.timer);
      if ('error' in m) {
        const err = m.error as { message?: string; code?: number };
        p.reject(new Error(err.message ?? `JSON-RPC error (code ${err.code})`));
      } else {
        p.resolve(m.result);
      }
      return;
    }
    if ('method' in m && !('id' in m)) {
      // Notification
      const method = m.method as string;
      const handlers = this.notificationHandlers.get(method) ?? [];
      handlers.forEach((h) => h(m.params));
      return;
    }
    // Server-initiated request (has id + method, no result/error) — handled in next task
  }
}
