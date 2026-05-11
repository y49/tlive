// src/kernel/session/manager.ts

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RuntimeAdapter } from '../contracts/runtime-adapter.js';
import { SessionPersistence } from './persistence.js';
import type { SessionContextSnapshot } from './context.js';

export interface SessionRecord {
  tliveSessionId: string;
  providerSessionId: string;
  workspaceDir: string;
  provider: string;
  runtime: RuntimeAdapter;
}

export interface SessionManagerOpts {
  home: string;
  runtimeFactory: (provider: string) => RuntimeAdapter;
}

export class SessionManager {
  private readonly persistence: SessionPersistence;
  private readonly factory: (provider: string) => RuntimeAdapter;
  private readonly active = new Map<string, SessionRecord>();

  constructor(opts: SessionManagerOpts) {
    this.persistence = new SessionPersistence(opts.home);
    this.factory = opts.runtimeFactory;
  }

  async create(opts: { workspaceDir: string; provider: string }): Promise<SessionRecord> {
    const tliveSessionId = randomUUID();
    const runtime = this.factory(opts.provider);
    const { providerSessionId } = await runtime.start({ workspaceDir: opts.workspaceDir });
    const rec: SessionRecord = {
      tliveSessionId, providerSessionId,
      workspaceDir: opts.workspaceDir, provider: opts.provider, runtime,
    };
    this.active.set(tliveSessionId, rec);
    const snap: SessionContextSnapshot = {
      tliveSessionId, providerSessionId,
      workspaceDir: opts.workspaceDir, provider: opts.provider,
      createdAt: Date.now(),
    };
    this.persistence.save(snap);
    return rec;
  }

  async resume(tliveSessionId: string): Promise<SessionRecord | null> {
    if (this.active.has(tliveSessionId)) return this.active.get(tliveSessionId)!;
    const snap = this.persistence.load(tliveSessionId);
    if (!snap) return null;
    const runtime = this.factory(snap.provider);
    await runtime.start({
      workspaceDir: snap.workspaceDir,
      // CRITICAL: pass the provider's own id, NOT tliveSessionId.
      resumeProviderSessionId: snap.providerSessionId,
    });
    const rec: SessionRecord = {
      tliveSessionId: snap.tliveSessionId,
      providerSessionId: snap.providerSessionId,
      workspaceDir: snap.workspaceDir,
      provider: snap.provider,
      runtime,
    };
    this.active.set(snap.tliveSessionId, rec);
    return rec;
  }

  get(tliveSessionId: string): SessionRecord | undefined {
    return this.active.get(tliveSessionId);
  }

  async stop(tliveSessionId: string): Promise<void> {
    const r = this.active.get(tliveSessionId);
    if (!r) return;
    await r.runtime.stop();
    this.active.delete(tliveSessionId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.active.values()).map((r) => r.runtime.stop()));
    this.active.clear();
  }

  listActive(): SessionRecord[] {
    return Array.from(this.active.values());
  }
}
