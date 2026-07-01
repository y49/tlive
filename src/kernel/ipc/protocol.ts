// src/kernel/ipc/protocol.ts

export interface SessionMeta {
  id: string;
  label: string;
  cmd: string;
  cwd: string;
  pid: number;
  sockPath: string;
}

export type IpcRequest =
  | { kind: 'daemon.status' }
  | { kind: 'daemon.stop' }
  | { kind: 'hook.permission.request'; cwd: string; sessionId: string; toolName: string; input: unknown; permissionMode?: string }
  | { kind: 'hook.permission.answer'; requestId: string; approved: boolean }
  | { kind: 'hook.continue.request'; cwd: string; sessionId: string; context: string }
  | { kind: 'hook.notify'; cwd: string; sessionId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'session.register'; session: SessionMeta }
  | { kind: 'session.unregister'; id: string }
  | { kind: 'session.list' };

export type IpcResponse =
  | { kind: 'daemon.status'; uptimeMs: number; pid: number }
  | { kind: 'daemon.stopped' }
  | { kind: 'ack' }
  | { kind: 'hook.permission.result'; decision: 'allow' | 'deny' | 'defer' }
  | { kind: 'hook.continue.result'; reply: string | null }
  | { kind: 'session.list'; sessions: SessionMeta[] }
  | { kind: 'error'; message: string };
