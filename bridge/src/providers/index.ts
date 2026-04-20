import { ClaudeSDKProvider } from './claude-sdk.js';
import { CodexAppServerProvider } from './codex-app-server/index.js';
import type { LLMProvider } from './base.js';
import type { PendingPermissions } from '../permissions/gateway.js';
import type { ClaudeSettingSource } from '../config.js';

export interface ProviderOptions {
  claudeSettingSources?: ClaudeSettingSource[];
}

export function resolveProvider(runtime: string, permissions: PendingPermissions, options?: ProviderOptions): LLMProvider {
  switch (runtime) {
    case 'codex':
      return new CodexAppServerProvider();
    case 'claude':
    case 'auto':
    default:
      return new ClaudeSDKProvider(permissions, options?.claudeSettingSources);
  }
}

// Module-level provider instance for availability checks (reuses module-level cache in CodexAppServerProvider)
const _codexProvider = new CodexAppServerProvider();

/** Async check: resolves true if the codex binary (>=0.121.0) is available. Result is cached for process lifetime. */
export async function checkCodexAvailable(): Promise<boolean> {
  return _codexProvider.isAvailable();
}

/** Sync shim: returns false until the first async check completes. Use checkCodexAvailable() for accurate result. */
export function isCodexAvailable(): boolean {
  // Kick off the async check if not already started; return false synchronously
  void _codexProvider.isAvailable();
  return false;
}

export { ClaudeSDKProvider } from './claude-sdk.js';
export { CodexAppServerProvider } from './codex-app-server/index.js';
export type { PermissionTimeoutCallback } from './claude-sdk.js';
export type { LLMProvider, StreamChatParams } from './base.js';
