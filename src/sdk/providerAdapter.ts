// src/sdk/providerAdapter.ts

/**
 * Minimal stub for BasePermissionHandler.
 * Will be replaced with the real import from ./permissionHandler.js in Task 6.
 */
export interface BasePermissionHandler {
  handleToolCall(
    toolName: string,
    input: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    behavior: 'allow' | 'deny' | 'error';
    updatedInput?: unknown;
    message?: string;
  }>;
}

export interface NormalizedMessage {
  kind:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'permission_request'
    | 'permission_result'
    | 'status'
    | 'error'
    | 'complete';
  provider: 'claude' | 'codex';
  sessionId: string;
  text?: string;
  html?: string;
  buttons?: Array<{
    label: string;
    callbackData: string;
    style?: 'primary' | 'danger';
  }>;
  toolName?: string;
  toolInput?: unknown;
  parentToolUseId?: string;
}

export interface SpawnOptions {
  sessionId: string;
  cwd: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RemoteOptions {
  sessionId: string;
  cwd: string;
  prompt?: string;
  resume?: boolean;
  permissionHandler: BasePermissionHandler;
  signal?: AbortSignal;
  onAskUserQuestion?: (
    question: string,
    resolve: (answer: string) => void,
  ) => void;
}

export interface ProviderAdapter {
  name: string;
  resolveExecutable(): Promise<string>;
  getSessionIdArgs(sessionId: string): string[];
  getResumeArgs(sessionId: string): string[];
  spawnArgs(opts: SpawnOptions): string[];
  startRemote(opts: RemoteOptions): AsyncIterable<NormalizedMessage>;
  getSessionDir(workdir: string): string;
}
