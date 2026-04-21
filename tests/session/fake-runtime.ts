// tests/session/fake-runtime.ts
import type { AgentRuntime, AgentRuntimeOptions, PermissionRequest } from '../../src/runtime/types.js';
import type { NotificationEvent, UsageStats } from '../../src/runtime/events.js';

export class FakeRuntime implements AgentRuntime {
  readonly provider: 'claude' | 'codex';
  startCalls = 0;
  inputs: string[] = [];
  stopCalls = 0;
  started = false;
  private eventCbs = new Set<(e: NotificationEvent) => void>();
  private permCbs = new Set<(r: PermissionRequest) => void>();
  private usageCbs = new Set<(u: UsageStats) => void>();

  constructor(provider: 'claude' | 'codex' = 'claude') { this.provider = provider; }

  async start(_opts: AgentRuntimeOptions): Promise<void> {
    if (this.started) throw new Error('runtime already started');
    this.started = true;
    this.startCalls++;
  }
  async sendInput(text: string): Promise<void> { this.inputs.push(text); }
  async stop(): Promise<void> { this.stopCalls++; this.started = false; }
  onEvent(cb: (e: NotificationEvent) => void) { this.eventCbs.add(cb); return () => this.eventCbs.delete(cb); }
  onPermissionRequest(cb: (r: PermissionRequest) => void) { this.permCbs.add(cb); return () => this.permCbs.delete(cb); }
  onUsage(cb: (u: UsageStats) => void) { this.usageCbs.add(cb); return () => this.usageCbs.delete(cb); }

  // Test helpers
  emitEvent(e: NotificationEvent) { for (const cb of this.eventCbs) cb(e); }
  emitPermission(r: PermissionRequest) { for (const cb of this.permCbs) cb(r); }
  emitUsage(u: UsageStats) { for (const cb of this.usageCbs) cb(u); }
}
