// src/runtime/abstractions.ts
//
// Shared runtime helpers: UnsupportedByRuntimeError + capability matrix type.

import type { AgentProvider } from './types.js';

export class UnsupportedByRuntimeError extends Error {
  readonly code = 'UNSUPPORTED_BY_RUNTIME';
  constructor(readonly provider: AgentProvider, readonly method: string) {
    super(`${method} is not supported by the ${provider} runtime`);
    this.name = 'UnsupportedByRuntimeError';
  }
}

/** Convenience: wrap a no-op method that should throw UnsupportedByRuntimeError. */
export function unsupported(provider: AgentProvider, method: string): never {
  throw new UnsupportedByRuntimeError(provider, method);
}

/**
 * Capability matrix describing what each provider supports. Consumers (IM frontends
 * and control-panel code) use this to gate UI affordances. Populated by each
 * runtime module; keep keys aligned with AgentRuntime method names.
 */
export type CapabilityMatrix = Readonly<Record<AgentProvider, Readonly<Record<string, boolean>>>>;
