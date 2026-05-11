// src/kernel/mcp/server.ts

import { FROZEN_MCP_TOOLS, type FrozenMcpToolName } from '../contracts/mcp-tools.js';
import type { IpcRequest, IpcResponse } from '../ipc/protocol.js';
import { makeApproveTool } from './tools/approve.js';
import { makeAskTool } from './tools/ask.js';
import { makeNotifyTool } from './tools/notify.js';

export interface McpServerDeps {
  ipcRequest: (req: IpcRequest) => Promise<IpcResponse>;
  attachInfo: { workspaceId: string | null; cwd: string };
}

export interface BuiltMcpServer {
  listTools(): Promise<typeof FROZEN_MCP_TOOLS>;
  callTool(name: FrozenMcpToolName, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

export function buildMcpServer(deps: McpServerDeps): BuiltMcpServer {
  const approve = makeApproveTool(deps);
  const ask = makeAskTool(deps);
  const notify = makeNotifyTool(deps);
  return {
    async listTools() { return FROZEN_MCP_TOOLS; },
    async callTool(name, args) {
      switch (name) {
        case 'mcp__tlive__approve': return approve(args as { toolName: string; input: unknown });
        case 'mcp__tlive__ask': return ask(args as { question: string; timeoutSec?: number });
        case 'mcp__tlive__notify': return notify(args as { message: string; level?: 'info' | 'warn' | 'error' });
      }
    },
  };
}
