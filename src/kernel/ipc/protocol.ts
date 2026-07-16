// src/kernel/ipc/protocol.ts

import type { SessionView } from '../web/session-registry.js';
import type { MonitorEvent } from '../hook/normalizer.js';

export interface SessionMeta {
  id: string;
  label: string;
  cmd: string;
  cwd: string;
  pid: number;
  sockPath: string;
  startedAt?: number; // ms epoch when `tlive run` launched — for uptime display
}

export type IpcRequest =
  | { kind: 'daemon.status' }
  | { kind: 'daemon.stop' }
  // wrappedId: TLIVE_SESSION inherited by the hook process when the agent runs
  // inside `tlive run` — routes hook traffic to that EXACT session card (so
  // several wrapped sessions can share one cwd).
  // timeoutSec: requested pending window (CC permission-request sends ~86000s;
  // absent = 580s legacy default). The daemon clamps it to 24h.
  // agentId: sub-agent identity (both vendors emit agent_id) — lets the daemon
  // cancel THIS agent's pending card on its local answer without touching
  // sibling agents that share the same key+tool.
  | { kind: 'hook.permission.request'; cwd: string; sessionId: string; toolName: string; input: unknown; permissionMode?: string; wrappedId?: string; timeoutSec?: number; agentId?: string }
  | { kind: 'hook.permission.answer'; requestId: string; approved: boolean; message?: string }
  | { kind: 'hook.continue.request'; cwd: string; sessionId: string; context: string; lastMessage?: string; wrappedId?: string }
  | { kind: 'hook.event'; event: MonitorEvent; wrappedId?: string }
  | { kind: 'hook.notify'; cwd: string; sessionId: string; level: 'info' | 'warn' | 'error'; message: string; wrappedId?: string }
  | { kind: 'session.register'; session: SessionMeta }
  | { kind: 'session.unregister'; id: string }
  // Terminal-derived activity for a wrapped session (running vs idle) — updates
  // active/idle without overriding a hook-driven waiting-* state.
  | { kind: 'session.activity'; id: string; active: boolean }
  | { kind: 'session.list' };

export type IpcResponse =
  | { kind: 'daemon.status'; uptimeMs: number; pid: number; codex?: 'running' | 'degraded' | 'off' }
  | { kind: 'daemon.stopped' }
  | { kind: 'ack' }
  | { kind: 'hook.permission.result'; decision: 'allow' | 'deny' | 'defer'; message?: string }
  | { kind: 'hook.continue.result'; reply: string | null }
  | { kind: 'session.list'; sessions: SessionView[] }
  | { kind: 'error'; message: string };
