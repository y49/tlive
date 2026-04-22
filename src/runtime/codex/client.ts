import type { StdioJsonlTransport } from './transport.js';

// Server-request method names — must match codex-app-server exactly
const METHOD_COMMAND_EXEC_APPROVAL = 'item/commandExecution/requestApproval';
const METHOD_FILE_CHANGE_APPROVAL = 'item/fileChange/requestApproval';
const METHOD_PERMISSIONS_APPROVAL = 'item/permissions/requestApproval';
const METHOD_MCP_ELICITATION = 'mcpServer/elicitation/request';

export class CodexAppServerClient {
  private initialized = false;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  private serverRequestHandlers = new Map<
    string,
    (params: unknown) => Promise<unknown>
  >();

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

  onCommandExecutionApproval(
    handler: (params: unknown) => Promise<unknown>,
  ): void {
    this.serverRequestHandlers.set(METHOD_COMMAND_EXEC_APPROVAL, handler);
  }

  onFileChangeApproval(
    handler: (params: unknown) => Promise<unknown>,
  ): void {
    this.serverRequestHandlers.set(METHOD_FILE_CHANGE_APPROVAL, handler);
  }

  onPermissionsApproval(
    handler: (params: unknown) => Promise<unknown>,
  ): void {
    this.serverRequestHandlers.set(METHOD_PERMISSIONS_APPROVAL, handler);
  }

  onMcpElicitation(
    handler: (params: unknown) => Promise<unknown>,
  ): void {
    this.serverRequestHandlers.set(METHOD_MCP_ELICITATION, handler);
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

    // Response: has id + (result or error)
    if ('id' in m && ('result' in m || 'error' in m)) {
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

    // Server-initiated request: has id + method
    if ('id' in m && 'method' in m) {
      this.handleServerRequest(m.id as number, m.method as string, m.params);
      return;
    }

    // Notification: has method but no id
    if ('method' in m && !('id' in m)) {
      const method = m.method as string;
      const handlers = this.notificationHandlers.get(method) ?? [];
      handlers.forEach((h) => h(m.params));
      return;
    }
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      console.warn(`[codex-client] Unhandled server request: ${method}`);
      this.transport.sendMessage({
        id,
        error: { code: -32601, message: `Method not handled by client: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.transport.sendMessage({ id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.transport.sendMessage({
        id,
        error: { code: -32000, message },
      });
    }
  }
}
