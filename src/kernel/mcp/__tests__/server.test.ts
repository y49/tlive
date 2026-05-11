import { describe, it, expect } from 'vitest';
import { buildMcpServer } from '../server';
import { FROZEN_MCP_TOOLS } from '../../contracts/mcp-tools';

describe('MCP server', () => {
  it('tools/list returns exactly 3 frozen tools', async () => {
    const srv = buildMcpServer({
      ipcRequest: async () => ({ kind: 'mcp.permission.result', approved: true } as const),
      attachInfo: { workspaceId: 'ws-1', cwd: '/tmp/foo' },
    });
    const tools = await srv.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...FROZEN_MCP_TOOLS.map((t) => t.name)].sort(),
    );
  });

  it('approve tool forwards to IPC and returns SDK-compatible response', async () => {
    let captured: unknown = null;
    const srv = buildMcpServer({
      ipcRequest: async (req) => { captured = req; return { kind: 'mcp.permission.result', approved: true }; },
      attachInfo: { workspaceId: 'ws-1', cwd: '/tmp/foo' },
    });
    const r = await srv.callTool('mcp__tlive__approve', { toolName: 'Bash', input: { cmd: 'ls' } });
    expect((captured as { kind: string }).kind).toBe('mcp.permission.request');
    // SDK expects content array
    expect(r.content[0].type).toBe('text');
  });
});
