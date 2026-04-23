// src/session/warm-pool.ts
//
// WarmRuntimePool — parks AgentRuntime subprocesses after LocalSession.stop()
// so the next `createLocal` in the same workspace+provider plucks a warm
// runtime (preserving auth/SDK init) instead of cold-starting. Cuts ~500ms
// typical cold start to ~50ms. TTL-bounded: unused entries are force-stopped
// after `ttlSec`, so the pool never leaks subprocesses into the daemon's
// lifetime.

import type { AgentProvider, AgentRuntime } from '../runtime/types.js';

interface WarmEntry {
  runtime: AgentRuntime;
  provider: AgentProvider;
  workspaceId: string;
  since: number;
  timer: NodeJS.Timeout;
}

export interface WarmRuntimePoolOptions {
  ttlSec?: number;
  max?: number;
}

export class WarmRuntimePool {
  private entries: WarmEntry[] = [];
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(opts: WarmRuntimePoolOptions = {}) {
    this.ttlMs = (opts.ttlSec ?? 60) * 1000;
    this.max = opts.max ?? 3;
  }

  /**
   * Deposit a runtime into the pool, keyed by (provider, workspaceId).
   * If full, the oldest entry is evicted + stopped. TTL timer starts
   * immediately; callers must not retain references to the runtime after
   * handoff.
   */
  park(runtime: AgentRuntime, workspaceId: string): void {
    if (this.entries.length >= this.max) {
      const evicted = this.entries.shift();
      if (evicted) {
        clearTimeout(evicted.timer);
        void evicted.runtime.stop().catch(() => undefined);
      }
    }
    const entry: WarmEntry = {
      runtime,
      provider: runtime.provider,
      workspaceId,
      since: Date.now(),
      timer: setTimeout(() => this.evict(entry), this.ttlMs),
    };
    // Keep Node event loop free of lingering pool entries during idle shutdown.
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    this.entries.push(entry);
  }

  /** Remove and return a matching runtime, cancelling its TTL. */
  pluck(provider: AgentProvider, workspaceId: string): AgentRuntime | null {
    const idx = this.entries.findIndex((e) => e.provider === provider && e.workspaceId === workspaceId);
    if (idx < 0) return null;
    const [entry] = this.entries.splice(idx, 1);
    clearTimeout(entry.timer);
    return entry.runtime;
  }

  /** Force-stop every parked runtime. Called from SessionManager.stopAll. */
  async drain(): Promise<void> {
    const entries = [...this.entries];
    this.entries = [];
    await Promise.all(entries.map((e) => {
      clearTimeout(e.timer);
      return e.runtime.stop().catch(() => undefined);
    }));
  }

  size(): number { return this.entries.length; }

  private evict(entry: WarmEntry): void {
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    void entry.runtime.stop().catch(() => undefined);
  }
}
