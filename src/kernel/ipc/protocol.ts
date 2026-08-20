// src/kernel/ipc/protocol.ts

import type { SessionView } from '../web/session-registry.js';
import type { MonitorEvent, SessionError, LocalWaiting } from '../hook/normalizer.js';

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
  | { kind: 'daemon.set'; key: 'mute' | 'trust' | 'safe'; enabled: boolean }
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
  // agentPid: the agent process that ran this hook (CLAUDE_PID). Recorded on
  // the session so the liveness sweep can reap it when that process dies
  // without firing SessionEnd — kill -9, a crash, or a hard-closed terminal
  // run no hooks at all, and SessionEnd was a hook session's only way out.
  | { kind: 'hook.event'; event: MonitorEvent; wrappedId?: string; agentPid?: number }
  // droppable: "这条不进 IM"的透传标记,由 normalizer 判定。今天的唯一来源
  // 是工具失败(含被 Esc 打断的):错误原样回给 agent,它下一轮自己处理,没
  // 人需要为它做什么。daemon 侧只据此跳过 IM 发送(见 bootstrap.ts 的
  // hook.notify handler);dashboard 广播不受影响,照常收到 —— 这条 attention
  // 往往是 dashboard 看到这次工具活动的唯一途径(PostToolUse/
  // PostToolUseFailure 互斥,失败时没有 activity 事件替补)。
  // localWaiting: CC Notification 里那五种「有东西卡在这台机器上」的类型的透传
  // 标记(issue #49 起于其中的 permission_prompt)。`approval` 与 `blocked` 的
  // 区别不是措辞:tlive 可能正持着同一件事的可答卡(approval),但**永远不可能**
  // 持着 elicitation 对话框或 teammate 转发来的请求(blocked)——所以后者在任何
  // 档位下都必须落地,前者要先让开已有的卡。
  // daemon 据 pending 判重:full 模式已有 held 卡 → 丢(卡管全部答复面);
  // 没卡(notify 模式 / 立即 defer)→ 本地对话框在等 = 走等待通知链
  // (desktop ping + dashboard 只读 waiting-approval + grace 后 IM 文本)。
  // agentPid: same purpose as on hook.event. Carried here too because a daemon
  // that restarts mid-session never sees that session's SessionStart, and a
  // notification may be the first hook it does see — an idle session recreated
  // without a pid could never be reaped.
  // sessionError: present only for StopFailure — the turn ended on an API
  // error. Carries Claude Code's own transient/not judgement, which is what
  // decides whether this rings a desktop bell: a `server_error` blip the
  // session picks up from calls nobody back, a bad key does.
  | { kind: 'hook.notify'; cwd: string; sessionId: string; level: 'info' | 'warn' | 'error'; message: string; wrappedId?: string; droppable?: boolean; localWaiting?: LocalWaiting; agentPid?: number; sessionError?: SessionError }
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
