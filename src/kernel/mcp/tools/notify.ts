// src/kernel/mcp/tools/notify.ts

import type { IpcRequest, IpcResponse } from '../../ipc/protocol.js';

export function makeNotifyTool(deps: { ipcRequest: (req: IpcRequest) => Promise<IpcResponse> }) {
  return async (args: { message: string; level?: 'info' | 'warn' | 'error' }) => {
    const r = await deps.ipcRequest({
      kind: 'mcp.notify',
      message: args.message,
      ...(args.level !== undefined ? { level: args.level } : {}),
    });
    if (r.kind !== 'mcp.notify.ack') {
      return { content: [{ type: 'text' as const, text: 'notify: broker error' }] };
    }
    return { content: [{ type: 'text' as const, text: 'ok' }] };
  };
}
