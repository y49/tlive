// src/cli/subcommands/mcp.ts
//
// Thin MCP stdio entry point. NO state held here — every tool call is
// an IPC round-trip to the daemon.
//
// Wired into Claude/Codex via mcp.json: { "tlive": { "command": "tlive", "args": ["mcp"] } }

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from '../../kernel/mcp/server.js';
import { request as ipcRequest, defaultSocketPath } from '../../kernel/ipc/client.js';
import type { FrozenMcpToolName } from '../../kernel/contracts/mcp-tools.js';

export async function runMcpEntry(): Promise<void> {
  // Tell daemon we're attaching: cwd → workspace lookup happens daemon-side.
  let workspaceId: string | null = null;
  try {
    const r = await ipcRequest(
      { kind: 'mcp.attach', cwd: process.cwd(), pid: process.pid },
      { socketPath: defaultSocketPath(), timeoutMs: 2000 },
    );
    if (r.kind === 'mcp.attached') workspaceId = r.workspaceId;
  } catch {
    process.stderr.write('tlive mcp: daemon not reachable; permission tools will deny.\n');
  }

  const built = buildMcpServer({
    ipcRequest: (req) => ipcRequest(req, { socketPath: defaultSocketPath(), timeoutMs: 60_000 }),
    attachInfo: { workspaceId, cwd: process.cwd() },
  });

  const server = new Server({ name: 'tlive', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await built.listTools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return built.callTool(req.params.name as FrozenMcpToolName, (req.params.arguments ?? {}) as Record<string, unknown>);
  });

  await server.connect(new StdioServerTransport());
}
