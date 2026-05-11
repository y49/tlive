// src/kernel/mcp/tools/ask.ts

import type { IpcRequest, IpcResponse } from '../../ipc/protocol.js';

export function makeAskTool(deps: { ipcRequest: (req: IpcRequest) => Promise<IpcResponse> }) {
  return async (args: { question: string; timeoutSec?: number }) => {
    const r = await deps.ipcRequest({
      kind: 'mcp.ask',
      question: args.question,
      ...(args.timeoutSec !== undefined ? { timeoutSec: args.timeoutSec } : {}),
    });
    if (r.kind !== 'mcp.ask.result') {
      return { content: [{ type: 'text' as const, text: 'ask: broker error' }] };
    }
    return { content: [{ type: 'text' as const, text: r.reply }] };
  };
}
