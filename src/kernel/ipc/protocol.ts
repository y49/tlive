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
  // Runtime toggle. `enabled` = "this switch is ON" (for `mute`, on = muted).
  // mute/trust/safe are shared with the IM /mute|/trust|/safe commands; the CLI
  // (`tlive mute on` …) is the at-the-terminal entrance to the same setters.
  // `desktop` is CLI-only (`tlive desktop on|off`) — a machine-local control
  // with no IM command, independent of `mute` (additive, 2026-07-21).
  | { kind: 'daemon.set'; key: 'mute' | 'trust' | 'safe' | 'desktop'; enabled: boolean }
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
  // droppable: normalizer 判定"无实际错误内容"(如 Bash 非零退出但 stderr
  // 为空)的 attention 事件透传标记。daemon 侧只据此跳过 IM 发送(见
  // bootstrap.ts 的 hook.notify handler);dashboard 广播不受影响,照常收到
  // ——这条 attention 往往是 dashboard 看到这次工具活动的唯一途径
  // (PostToolUse/PostToolUseFailure 互斥,失败时没有 activity 事件替补)。
  | { kind: 'hook.notify'; cwd: string; sessionId: string; level: 'info' | 'warn' | 'error'; message: string; wrappedId?: string; droppable?: boolean }
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
  | { kind: 'hook.permission.result'; decision: 'allow' | 'deny' | 'defer'; message?: string; updatedInput?: unknown }
  | { kind: 'hook.continue.result'; reply: string | null }
  | { kind: 'session.list'; sessions: SessionView[] }
  | { kind: 'error'; message: string };
