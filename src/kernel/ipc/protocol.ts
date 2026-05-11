// src/kernel/ipc/protocol.ts

export type IpcRequest =
  | { kind: 'daemon.status' }
  | { kind: 'daemon.stop' }
  | { kind: 'session.list' }
  | { kind: 'mcp.attach'; cwd: string; pid: number }
  | { kind: 'mcp.permission.request'; sessionContextHint?: string; toolName: string; input: unknown }
  | { kind: 'mcp.permission.answer'; requestId: string; approved: boolean }
  | { kind: 'handoff.register'; sdkSessionId: string; cwd: string };

export type IpcResponse =
  | { kind: 'daemon.status'; uptimeMs: number; pid: number; sessionCount: number }
  | { kind: 'daemon.stopped' }
  | { kind: 'session.list'; sessions: Array<{ tliveSessionId: string; providerSessionId: string; provider: string; workspaceDir: string }> }
  | { kind: 'mcp.attached'; workspaceId: string | null }
  | { kind: 'mcp.permission.result'; approved: boolean }
  | { kind: 'handoff.registered'; tliveSessionId: string }
  | { kind: 'error'; message: string };
