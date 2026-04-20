// src/sdk/index.ts
// Barrel + factory. Lets runFlavor and tests instantiate adapters without
// switching on provider name at each call site.

import type { ProviderAdapter } from './providerAdapter.js';
import { ClaudeAdapter } from './claudeAdapter.js';
import { CodexAdapter } from './codexAdapter.js';

export { ClaudeAdapter, CodexAdapter };
export type { ProviderAdapter };

export type ProviderName = 'claude' | 'codex';

export function createProviderAdapter(name: ProviderName): ProviderAdapter {
  switch (name) {
    case 'claude': return new ClaudeAdapter();
    case 'codex':  return new CodexAdapter();
  }
}
