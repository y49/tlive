// src/ipc/dispatcher.ts
//
// IPC server dispatcher — translates a v1.0 `IpcRequest` envelope into the
// appropriate call on the daemon's subsystems and emits one or more
// `IpcResponse` frames back to the client.
//
// Wired by `src/daemon/bootstrap.ts` and consumed by `src/ipc/server.ts`.
//
// Streaming note: `session.logs` emits `logs.line` frames then `logs.end`.
// All other kinds emit a single response frame.

import { promises as fs } from 'node:fs';
import { createReadStream, watch as watchFs, type FSWatcher } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { IpcServerHandler } from './server.js';
import type {
  IpcRequest, IpcResponse, SessionListEntry, DoctorFinding,
} from './protocol.js';

import type { SessionManager } from '../session/manager.js';
import type { LocalSession } from '../session/local-session.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { SessionPersistence } from '../session/persistence.js';
import type { CostRollupStore } from '../cost/rollups.js';
import type { WarmRuntimePool } from '../session/warm-pool.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { ChannelType } from '../workspace/chat-instance.js';

export interface IpcDispatcherDeps {
  sessions: SessionManager;
  workspaces: WorkspaceManager;
  persistence: SessionPersistence;
  rollups?: CostRollupStore;
  warmPool?: WarmRuntimePool;
  adapters?: Partial<Record<ChannelType, PlatformAdapter>>;
  startedAt: number;
  requestDaemonShutdown: () => void;
}

/**
 * Build an `IpcServerHandler` closure targeting the supplied subsystems.
 * Returned function is passed to `startIpcServer({ handler })`.
 */
export function buildIpcDispatcher(deps: IpcDispatcherDeps): IpcServerHandler {
  return async (req: IpcRequest, reply: (r: IpcResponse) => void) => {
    try {
      switch (req.kind) {
        case 'daemon.status': {
          let adapters: Partial<Record<ChannelType, 'connected' | 'idle' | 'failed'>> | undefined;
          if (deps.adapters) {
            adapters = {};
            // Note: 'failed' is reserved in the protocol for an explicit init-
            // failure registry that doesn't exist yet. Adapters that fail
            // construction or start() are dropped from `deps.adapters` by the
            // bootstrap try/catch, so this path emits only 'connected' or
            // 'idle' today. The doctor's 'failed' branch (src/cli/doctor.ts)
            // remains for forward-compat — populating 'failed' here would
            // require tracking init-failure separately.
            for (const [ct, a] of Object.entries(deps.adapters)) {
              if (!a) continue;
              // PlatformAdapter is allowed to expose isConnected(); treat absence as
              // "connected" (the adapter is in our table, so it was started successfully).
              const ic = (a as PlatformAdapter & { isConnected?: () => boolean | null }).isConnected;
              const state = ic ? ic.call(a) : null;
              adapters[ct as ChannelType] = state === false ? 'idle' : 'connected';
            }
          }
          reply({
            kind: 'daemon.status',
            uptimeMs: Date.now() - deps.startedAt,
            sessionCount: deps.sessions.listInfo().length,
            warmPoolCount: deps.warmPool?.size() ?? 0,
            pid: process.pid,
            ...(adapters ? { adapters } : {}),
          });
          return;
        }
        case 'daemon.stop': {
          reply({ kind: 'daemon.stopped' });
          // Schedule shutdown for after the reply has flushed.
          setTimeout(() => deps.requestDaemonShutdown(), 10).unref?.();
          return;
        }
        case 'session.list': {
          const list = await buildSessionList(deps);
          reply({ kind: 'session.list', sessions: list });
          return;
        }
        case 'session.stop': {
          const resolved = resolveSession(deps.sessions, req.alias);
          if (!resolved) {
            reply({ kind: 'error', message: `no session matches '${req.alias}'` });
            return;
          }
          await deps.sessions.stop(resolved);
          reply({ kind: 'session.stopped', sdkSessionId: resolved });
          return;
        }
        case 'session.logs': {
          const resolved = resolveSession(deps.sessions, req.alias)
            ?? (await resolveSessionFromPersistence(deps.persistence, req.alias));
          if (!resolved) {
            reply({ kind: 'error', message: `no session matches '${req.alias}'` });
            return;
          }
          await streamLogs(resolved, req.follow === true, reply);
          return;
        }
        case 'doctor.report': {
          const findings = await collectDoctorFindings(deps);
          reply({ kind: 'doctor.report', findings });
          return;
        }
        case 'handoff.release': {
          const resolved = resolveSession(deps.sessions, req.alias);
          if (!resolved) {
            reply({ kind: 'error', message: `no session matches '${req.alias}'` });
            return;
          }
          await deps.sessions.stop(resolved);
          reply({ kind: 'handoff.released', sdkId: resolved });
          return;
        }
        case 'handoff.take': {
          const resumed = await deps.sessions.resumeLocal(req.sdkId);
          if (!resumed) {
            reply({ kind: 'error', message: `cannot resume '${req.sdkId}'` });
            return;
          }
          reply({ kind: 'handoff.taken', sdkId: resumed.id });
          return;
        }
        case 'workspace.add': {
          const w = req.workspace;
          const existing = deps.workspaces.findByWorkdir(w.workdir);
          if (existing) {
            reply({ kind: 'workspace.added', workspaceId: existing.id });
            return;
          }
          const created = deps.workspaces.create({
            name: w.name,
            workdir: w.workdir,
            gitRemote: w.gitRemote,
            defaults: w.defaults,
            budget: w.budget,
          });
          // T3-PENDING: w.roles / w.defaultRole removed in chat-trust
          await deps.workspaces.save().catch(() => undefined);
          reply({ kind: 'workspace.added', workspaceId: created.id });
          return;
        }
        case 'workspace.list': {
          const workspaces = deps.workspaces.list().map(ws => {
            // T3-PENDING: admin field removed in chat-trust
            const allInstances = deps.workspaces.listChatInstances().filter((c) => c.workspaceId === ws.id);
            const firstActive = allInstances
              .map((c) => c.activeSessionId)
              .find((id): id is string => Boolean(id)) ?? null;
            return {
              id: ws.id,
              name: ws.name,
              workdir: ws.workdir,
              admin: null as string | null,
              bindings: allInstances.length,
              activeSessionId: firstActive,
            };
          });
          reply({ kind: 'workspace.list', workspaces });
          return;
        }
        case 'workspace.remove': {
          const all = deps.workspaces.list();
          const target = all.find(w => w.id === req.idOrName || w.name === req.idOrName);
          if (!target) {
            reply({ kind: 'workspace.removed', ok: false, reason: `not found: ${req.idOrName}` });
            return;
          }
          // Stop every per-chat active session in the workspace — prevents
          // dangling LocalSessions in SessionManager with orphaned
          // workspaceIds after the workspace record is deleted.
          const boundInstances = deps.workspaces.listChatInstances().filter((c) => c.workspaceId === target.id);
          for (const inst of boundInstances) {
            if (!inst.activeSessionId) continue;
            const live = deps.sessions.get(inst.activeSessionId);
            if (live && live.kind === 'local') {
              try { await (live as LocalSession).stop(); }
              catch { /* best-effort — workspace deletion proceeds regardless */ }
            }
          }
          deps.workspaces.removeWorkspace(target.id, { force: true });
          await deps.workspaces.save().catch(() => undefined);
          reply({ kind: 'workspace.removed', ok: true });
          return;
        }
        default: {
          const exhaustive: never = req;
          reply({ kind: 'error', message: `unsupported request: ${JSON.stringify(exhaustive)}` });
        }
      }
    } catch (err) {
      reply({ kind: 'error', message: (err as Error).message ?? String(err) });
    }
  };
}

// ---- Helpers ---------------------------------------------------------------

async function buildSessionList(deps: IpcDispatcherDeps): Promise<SessionListEntry[]> {
  const live = deps.sessions.listInfo();
  const metas = await deps.persistence.loadAllMeta().catch(() => []);
  const byId = new Map(live.map((l) => [l.id, l]));
  const out: SessionListEntry[] = [];
  // Live sessions first.
  for (const info of live) {
    const ws = deps.workspaces.get(info.workspaceId);
    out.push({
      sdkSessionId: info.id,
      shortAlias: info.shortAlias,
      workspaceId: info.workspaceId,
      workspaceName: ws?.name,
      workdir: info.workdir,
      provider: info.provider,
      kind: info.kind,
      status: info.status.phase,
      lastActivityAt: new Date(info.lastActivityAt).toISOString(),
      costUsd: info.cost.totalCost,
    });
  }
  // Add persisted-but-stopped meta rows.
  for (const m of metas) {
    if (byId.has(m.sdkSessionId)) continue;
    const ws = deps.workspaces.get(m.workspaceId);
    out.push({
      sdkSessionId: m.sdkSessionId,
      shortAlias: m.sdkSessionId.slice(0, 8),
      workspaceId: m.workspaceId,
      workspaceName: ws?.name,
      workdir: m.workdir ?? ws?.workdir ?? '',
      provider: m.provider,
      kind: 'local',
      status: m.status,
      lastActivityAt: m.lastActivityAt,
      costUsd: m.cost?.totalCost ?? 0,
    });
  }
  return out;
}

function resolveSession(mgr: SessionManager, alias: string): string | null {
  const { resolved } = mgr.getByPrefix(alias);
  if (resolved) return resolved.id;
  // Exact id match fallback.
  for (const info of mgr.listInfo()) {
    if (info.id === alias) return info.id;
  }
  return null;
}

async function resolveSessionFromPersistence(
  persistence: SessionPersistence,
  alias: string,
): Promise<string | null> {
  try {
    const metas = await persistence.loadAllMeta();
    for (const m of metas) {
      if (m.sdkSessionId === alias) return m.sdkSessionId;
      if (m.sdkSessionId.startsWith(alias)) return m.sdkSessionId;
    }
  } catch { /* isolate */ }
  return null;
}

async function streamLogs(
  sdkSessionId: string,
  follow: boolean,
  reply: (r: IpcResponse) => void,
): Promise<void> {
  const path = join(homedir(), '.tlive', 'sessions', `${sdkSessionId}.jsonl`);
  try { await fs.access(path); }
  catch {
    reply({ kind: 'error', message: `no history for ${sdkSessionId}` });
    return;
  }

  // Initial pass: read the whole file.
  const startSize = (await fs.stat(path)).size;
  const linesSent = await streamFromOffset(path, 0, sdkSessionId, reply);
  void linesSent; // suppress unused

  if (!follow) {
    reply({ kind: 'logs.end', sdkSessionId });
    return;
  }

  // Follow mode — watch for appends using fs.watch, emit new lines as they
  // arrive. Stop after a sane default window if nothing arrives to avoid
  // hung connections; the CLI client can re-invoke if needed.
  let offset = startSize;
  let watcher: FSWatcher | null = null;
  const done = new Promise<void>((resolve) => {
    const followTimeout = setTimeout(() => {
      try { watcher?.close(); } catch { /* isolate */ }
      reply({ kind: 'logs.end', sdkSessionId });
      resolve();
    }, 10 * 60 * 1000); // 10 min cap
    followTimeout.unref?.();
    try {
      watcher = watchFs(path, { persistent: false }, async (evt) => {
        if (evt === 'change') {
          try {
            const stat = await fs.stat(path);
            if (stat.size > offset) {
              await streamFromOffset(path, offset, sdkSessionId, reply);
              offset = stat.size;
            }
          } catch { /* isolate */ }
        }
      });
    } catch {
      clearTimeout(followTimeout);
      reply({ kind: 'logs.end', sdkSessionId });
      resolve();
    }
  });
  await done;
}

async function streamFromOffset(
  path: string,
  start: number,
  sdkSessionId: string,
  reply: (r: IpcResponse) => void,
): Promise<number> {
  let count = 0;
  await new Promise<void>((resolve) => {
    const rl = createInterface({
      input: createReadStream(path, { encoding: 'utf-8', start }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      reply({ kind: 'logs.line', sdkSessionId, line });
      count += 1;
    });
    rl.on('close', () => resolve());
    rl.on('error', () => resolve());
  });
  return count;
}

async function collectDoctorFindings(deps: IpcDispatcherDeps): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  findings.push({
    section: 'daemon',
    ok: true,
    message: `uptime ${Math.round((Date.now() - deps.startedAt) / 1000)}s`,
  });
  findings.push({
    section: 'sessions',
    ok: true,
    message: `${deps.sessions.listInfo().length} live`,
  });
  findings.push({
    section: 'workspaces',
    ok: deps.workspaces.list().length > 0,
    message: `${deps.workspaces.list().length} registered`,
  });
  return findings;
}
