// src/kernel/mcp/tools/approve.ts

import type { IpcRequest, IpcResponse } from '../../ipc/protocol.js';

export interface ApproveToolDeps {
  ipcRequest: (req: IpcRequest) => Promise<IpcResponse>;
}

export function makeApproveTool(deps: ApproveToolDeps) {
  return async (args: { toolName: string; input: unknown }) => {
    const r = await deps.ipcRequest({
      kind: 'mcp.permission.request',
      toolName: args.toolName,
      input: args.input,
    });
    if (r.kind !== 'mcp.permission.result') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ behavior: 'deny', message: 'broker error' }) }] };
    }
    const payload = r.approved
      ? { behavior: 'allow', updatedInput: args.input }
      : { behavior: 'deny', message: 'denied by user' };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  };
}
