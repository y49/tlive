// src/kernel/mcp/tools/notify.ts
//
// Forwards to daemon via IPC. Daemon-side broker (Phase 5.4) actually
// pushes the notification to bound IM chats.

import type { IpcRequest, IpcResponse } from '../../ipc/protocol.js';

export function makeNotifyTool(_deps: { ipcRequest: (req: IpcRequest) => Promise<IpcResponse> }) {
  return async (args: { message: string; level?: 'info' | 'warn' | 'error' }) => {
    void args; // wired in Phase 5.4
    return { content: [{ type: 'text' as const, text: 'ok' }] };
  };
}
