// src/sdk/providerAdapter.ts

import type { BasePermissionHandler } from './permissionHandler.js';
export type { BasePermissionHandler };

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
  toolUseId?: string;
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

export interface ProviderCapabilityFlags {
  /**
   * Whether `startRemote` is implemented (i.e. SDK-driven live session is
   * supported). Used by runFlavor to gate `permission_action` / takeover
   * handlers so Codex (PTY-only) doesn't crash when a user taps Takeover.
   */
  liveSession?: boolean;
}

/**
 * Thinking-tracker trigger derived from a scanner event.
 * Provider adapters map their raw event schema into this neutral shape so
 * SessionManager can drive the ThinkingTracker without knowing provider details.
 */
export interface ThinkingTriggerEvent {
  type: 'tool_use' | 'text' | 'tool_result';
  toolUseId?: string;
}

export interface ProviderAdapter {
  name: string;
  capabilities?: ProviderCapabilityFlags;
  resolveExecutable(): Promise<string>;
  getSessionIdArgs(sessionId: string): string[];
  getResumeArgs(sessionId: string): string[];
  spawnArgs(opts: SpawnOptions): string[];
  startRemote(opts: RemoteOptions): AsyncIterable<NormalizedMessage>;
  getSessionDir(workdir: string): string;
  /**
   * Optional: find the most recent session ID for a given workdir, used by
   * `--resume`. Providers that let us pick the session id (Claude) implement
   * this; providers that assign their own (Codex) leave it undefined and rely
   * on the scanner's mtime discovery.
   */
  findLastSession?(workdir: string): string | null;
  /**
   * Optional: extract thinking-tracker triggers from a scanner event.
   * Providers with a known content-block schema (Claude) implement this.
   * Providers without one (Codex) leave it undefined; SessionManager
   * gracefully no-ops for those and the thinking indicator simply stays idle.
   */
  extractThinkingEvents?(event: unknown): ThinkingTriggerEvent[];
  /**
   * Normalize a raw session event (provider-specific shape) into NormalizedMessage[].
   * Returns [] if the event produces no user-visible content.
   * Optional — adapters that don't implement this fall back to legacy normalizeSessionLine.
   */
  normalizeSessionEvent?(event: unknown, ctx?: { sessionId?: string }): NormalizedMessage[];
}
