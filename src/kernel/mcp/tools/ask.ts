// src/kernel/mcp/tools/ask.ts
//
// Forwards to daemon via IPC. Daemon-side broker (Phase 5.4) handles the
// actual IM round-trip. For Phase 5.1, this is the bare wiring.

import type { IpcRequest, IpcResponse } from '../../ipc/protocol.js';

export function makeAskTool(_deps: { ipcRequest: (req: IpcRequest) => Promise<IpcResponse> }) {
  return async (args: { question: string; timeoutSec?: number }) => {
    void args; // wired in Phase 5.4
    return { content: [{ type: 'text' as const, text: 'ask unimplemented (Phase 5.4)' }] };
  };
}
