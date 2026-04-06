export type { BridgeStore } from './store/interface.js';
export type { LLMProvider, ProviderCapabilities, LiveSession } from './providers/base.js';

export interface PermissionGateway {}
export interface CoreClient {}

export interface LifecycleHooks {
  onBridgeStart?(): Promise<void>;
  onBridgeStop?(): Promise<void>;
}

import type { BridgeStore } from './store/interface.js';
import type { LLMProvider } from './providers/base.js';

export interface BridgeContext {
  store: BridgeStore;
  llm: LLMProvider;
  permissions: PermissionGateway;
  core: CoreClient;
  lifecycle?: LifecycleHooks;
  defaultWorkdir: string;
}

const CONTEXT_KEY = '__termlive_bridge_context__';

export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = ctx;
}

export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as Record<string, unknown>)[CONTEXT_KEY];
  if (!ctx) throw new Error('BridgeContext not initialized. Call initBridgeContext() first.');
  return ctx as BridgeContext;
}
