import { basename } from 'node:path';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { validateWorkdir } from './workdir-validator.js';

export type ApprovalPolicy = 'on-request' | 'on-failure' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export type VerboseLevel = 0 | 1 | 2;
export type PermMode = 'on' | 'off';
export type Runtime = 'claude' | 'codex';

export interface Workspace {
  name: string;
  workdir: string;
  chatId?: string;
  threadId?: string;

  // Per-workspace preferences
  model?: string;
  effort?: EffortLevel;
  perm?: PermMode;
  approval?: ApprovalPolicy;
  sandbox?: SandboxMode;
  verbose?: VerboseLevel;

  // Session state (internal; not exposed to IM users)
  activeSessionId?: string;
  lastSessionId?: string;
  lastActivityAt?: number;

  runtime: Runtime;
}

export interface WorkspaceManagerOptions {
  persistPath: string | null;
  workdirWhitelist: readonly string[] | undefined;
}

export type OpenResult =
  | { ok: true; workspace: Workspace; created: boolean }
  | { ok: false; error: string };

export class WorkspaceManager {
  private byName = new Map<string, Workspace>();

  constructor(private opts: WorkspaceManagerOptions) {}

  /** Register a pre-configured workspace (from TL_WORKSPACES). Does not validate workdir yet. */
  register(input: { name: string; workdir: string; runtime: Runtime }): void {
    const existing = this.byName.get(input.name);
    if (existing) return;
    this.byName.set(input.name, {
      name: input.name,
      workdir: input.workdir,
      runtime: input.runtime,
    });
  }

  /** Open workspace by name — attaches chatId if provided. */
  openByName(name: string, ctx: { chatId?: string }): OpenResult {
    const ws = this.byName.get(name);
    if (!ws) return { ok: false, error: `Workspace not found: ${name}` };

    const v = validateWorkdir(ws.workdir, this.opts.workdirWhitelist);
    if (!v.ok) return { ok: false, error: v.error };
    ws.workdir = v.resolved;
    if (ctx.chatId) ws.chatId = ctx.chatId;
    return { ok: true, workspace: ws, created: false };
  }

  /** Open workspace by path — creates new if no match, otherwise reuses. */
  openByPath(path: string, ctx: { chatId: string; runtime: Runtime }): OpenResult {
    const v = validateWorkdir(path, this.opts.workdirWhitelist);
    if (!v.ok) return { ok: false, error: v.error };
    const resolved = v.resolved;

    const existing = this.findByWorkdir(resolved);
    if (existing) {
      existing.chatId = ctx.chatId;
      return { ok: true, workspace: existing, created: false };
    }

    const inferredName = basename(resolved) || resolved;
    const uniqueName = this.makeUniqueName(inferredName);
    const ws: Workspace = {
      name: uniqueName,
      workdir: resolved,
      chatId: ctx.chatId,
      runtime: ctx.runtime,
    };
    this.byName.set(uniqueName, ws);
    return { ok: true, workspace: ws, created: true };
  }

  findByName(name: string): Workspace | undefined {
    return this.byName.get(name);
  }

  findByWorkdir(workdir: string): Workspace | undefined {
    for (const ws of this.byName.values()) {
      if (ws.workdir === workdir) return ws;
    }
    return undefined;
  }

  findByThread(chatId: string, threadId?: string): Workspace | undefined {
    for (const ws of this.byName.values()) {
      if (ws.chatId === chatId && ws.threadId === threadId) return ws;
    }
    return undefined;
  }

  list(): Workspace[] {
    return [...this.byName.values()];
  }

  /** Mutate workspace in-place (for preference updates). */
  update(name: string, patch: Partial<Workspace>): Workspace | undefined {
    const ws = this.byName.get(name);
    if (!ws) return undefined;
    Object.assign(ws, patch);
    return ws;
  }

  private makeUniqueName(base: string): string {
    if (!this.byName.has(base)) return base;
    let i = 2;
    while (this.byName.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  load(): void {
    const p = this.opts.persistPath;
    if (!p || !existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as { workspaces: Workspace[] };
      if (!Array.isArray(raw.workspaces)) return;
      for (const ws of raw.workspaces) {
        if (typeof ws.name === 'string' && typeof ws.workdir === 'string' && typeof ws.runtime === 'string') {
          // Session runtime state is not restored; activeSessionId always clears on load
          this.byName.set(ws.name, { ...ws, activeSessionId: undefined });
        }
      }
    } catch (err) {
      console.warn(`[WorkspaceManager] Corrupt persist file ${p}: ${(err as Error).message}. Starting empty.`);
      try { renameSync(p, p + '.bak'); } catch { /* ignore */ }
    }
  }

  persist(): void {
    const p = this.opts.persistPath;
    if (!p) return;
    const data = { workspaces: [...this.byName.values()] };
    writeFileSync(p, JSON.stringify(data, null, 2));
  }
}
