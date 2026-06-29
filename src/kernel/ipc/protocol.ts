// src/kernel/ipc/protocol.ts

export type IpcRequest =
  | { kind: 'daemon.status' }
  | { kind: 'daemon.stop' }
  | { kind: 'hook.permission.request'; cwd: string; sessionId: string; toolName: string; input: unknown }
  | { kind: 'hook.permission.answer'; requestId: string; approved: boolean }
  | { kind: 'hook.continue.request'; cwd: string; sessionId: string; context: string }
  | { kind: 'hook.continue.answer'; requestId: string; reply: string }
  | { kind: 'hook.notify'; cwd: string; sessionId: string; level: 'info' | 'warn' | 'error'; message: string };

export type IpcResponse =
  | { kind: 'daemon.status'; uptimeMs: number; pid: number }
  | { kind: 'daemon.stopped' }
  | { kind: 'ack' }
  | { kind: 'hook.permission.result'; decision: 'allow' | 'deny' | 'defer' }
  | { kind: 'hook.continue.result'; reply: string | null }
  | { kind: 'error'; message: string };
