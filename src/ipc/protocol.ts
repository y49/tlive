// src/ipc/protocol.ts
//
// Collapsed IPC request/response union for the v1.0 daemon (spec §13.6).
//
// Request kinds surviving T10:
//   - daemon.status / daemon.stop
//   - session.list / session.stop / session.logs
//   - doctor.report
//   - handoff.release / handoff.take (skill HTTP backing)
//   - workspace.add (tlive setup)
//
// Removed: session creation, permission resolve, message send — all handled
// via IM / MCP directly, not via CLI.
//
// Wire format: newline-delimited JSON with an Envelope carrying a correlation
// id. `session.logs` uses streaming responses; a terminating `{kind:'logs.end'}`
// frame signals EOF so the client can close.

import type { TliveConfigV1 } from '../config/schema.js';

// ---- Request union ---------------------------------------------------------

export type IpcRequest =
  | { kind: 'daemon.status' }
  | { kind: 'daemon.stop' }
  | { kind: 'session.list' }
  | { kind: 'session.stop'; alias: string }
  | { kind: 'session.logs'; alias: string; follow?: boolean }
  | { kind: 'doctor.report' }
  | { kind: 'handoff.release'; alias: string }
  | { kind: 'handoff.take'; sdkId: string }
  | { kind: 'workspace.add'; workspace: TliveConfigV1['workspaces'][number] }
  | { kind: 'workspace.list' }
  | { kind: 'workspace.remove'; idOrName: string };

// ---- Response union --------------------------------------------------------

export interface SessionListEntry {
  sdkSessionId: string;
  shortAlias: string;
  workspaceId: string;
  workspaceName?: string;
  workdir: string;
  provider: 'claude' | 'codex';
  kind: 'local' | 'remote';
  status: string;
  lastActivityAt: string;
  costUsd: number;
}

export interface DoctorFinding {
  section: string;
  ok: boolean;
  message: string;
  detail?: string;
}

export interface WorkspaceListEntry {
  id: string;
  name: string;
  workdir: string;
  admin: string | null;     // first userId with role 'admin', or null
  bindings: number;
  activeSessionId: string | null;
}

export type IpcResponse =
  | {
      kind: 'daemon.status';
      uptimeMs: number;
      sessionCount: number;
      warmPoolCount: number;
      pid: number;
      adapters?: Partial<Record<'telegram' | 'feishu', 'connected' | 'idle' | 'failed'>>;
    }
  | { kind: 'daemon.stopped' }
  | { kind: 'session.list'; sessions: SessionListEntry[] }
  | { kind: 'session.stopped'; sdkSessionId: string }
  | { kind: 'logs.line'; sdkSessionId: string; line: string }
  | { kind: 'logs.end'; sdkSessionId: string }
  | { kind: 'doctor.report'; findings: DoctorFinding[] }
  | { kind: 'handoff.released'; sdkId: string }
  | { kind: 'handoff.taken'; sdkId: string }
  | { kind: 'workspace.added'; workspaceId: string }
  | { kind: 'workspace.list'; workspaces: WorkspaceListEntry[] }
  | { kind: 'workspace.removed'; ok: boolean; reason?: string }
  | { kind: 'error'; message: string; code?: string };

// ---- Envelope --------------------------------------------------------------

export interface Envelope<M> {
  requestId: string;
  message: M;
}

/** Encode a message envelope as a single line JSON with trailing newline. */
export function encodeFrame<M>(env: Envelope<M>): string {
  return JSON.stringify(env) + '\n';
}

/** Chunk parser — splits arriving bytes on '\n' and yields Envelope<T> values. */
export function createLineFramer<T>(onFrame: (env: Envelope<T>) => void): {
  push: (chunk: Buffer | string) => void;
} {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const p of parts) {
        if (!p.trim()) continue;
        try { onFrame(JSON.parse(p)); }
        catch { /* drop malformed */ }
      }
    },
  };
}
