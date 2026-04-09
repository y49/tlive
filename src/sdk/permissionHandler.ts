// src/sdk/permissionHandler.ts

export interface PermissionResult {
  behavior: 'allow' | 'deny' | 'error';
  updatedInput?: unknown;
  message?: string;
}

export interface PendingRequest {
  id: string;
  toolName: string;
  input: unknown;
  resolve: (result: PermissionResult) => void;
  timerId?: ReturnType<typeof setTimeout>;
}

export interface PermissionHandlerOptions {
  timeout?: number;
  onPermissionRequest?: (id: string, toolName: string, input: unknown) => void;
}

export abstract class BasePermissionHandler {
  protected pending = new Map<string, PendingRequest>();
  protected alwaysAllow = new Set<string>();

  abstract handleToolCall(
    toolName: string, input: unknown, opts?: { signal?: AbortSignal },
  ): Promise<PermissionResult>;

  waitForApproval(
    id: string, toolName: string, input: unknown,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        timerId = setTimeout(() => {
          this.pending.delete(id);
          resolve({ behavior: 'deny', message: 'Permission timeout' });
        }, opts.timeoutMs);
      }
      const entry: PendingRequest = { id, toolName, input, resolve, timerId };
      this.pending.set(id, entry);
      opts?.signal?.addEventListener('abort', () => {
        this.pending.delete(id);
        if (timerId) clearTimeout(timerId);
        resolve({ behavior: 'deny', message: 'Aborted' });
      }, { once: true });
    });
  }

  resolve(id: string, decision: 'allow' | 'deny' | 'allow_always', updatedInput?: unknown): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    if (pending.timerId) clearTimeout(pending.timerId);
    this.pending.delete(id);
    if (decision === 'allow_always') this.alwaysAllow.add(pending.toolName);
    pending.resolve({ behavior: decision === 'deny' ? 'deny' : 'allow', updatedInput });
    return true;
  }

  cancelAll(): void {
    for (const [, entry] of this.pending) {
      if (entry.timerId) clearTimeout(entry.timerId);
      entry.resolve({ behavior: 'deny', message: 'Cancelled' });
    }
    this.pending.clear();
  }

  get pendingCount(): number { return this.pending.size; }
}

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);

export function matchesToolPermission(toolName: string, pattern: string): boolean {
  if (pattern === toolName) return true;
  const match = pattern.match(/^(\w+)\(prefix:(.*)\)$/);
  if (match) {
    const [, patternTool] = match;
    return toolName === patternTool;
  }
  return false;
}

export class ClaudePermissionHandler extends BasePermissionHandler {
  private opts: PermissionHandlerOptions;
  private requestCounter = 0;

  constructor(opts: PermissionHandlerOptions = {}) {
    super();
    this.opts = opts;
  }

  async handleToolCall(
    toolName: string, input: unknown, callOpts?: { signal?: AbortSignal },
  ): Promise<PermissionResult> {
    if (this.alwaysAllow.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    const id = `perm-${++this.requestCounter}`;
    const isInteractive = INTERACTIVE_TOOLS.has(toolName);
    const timeoutMs = isInteractive ? 0 : (this.opts.timeout ?? 0);
    this.opts.onPermissionRequest?.(id, toolName, input);
    return this.waitForApproval(id, toolName, input, { signal: callOpts?.signal, timeoutMs });
  }
}
