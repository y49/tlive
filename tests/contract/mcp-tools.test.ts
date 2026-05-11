import { describe, it, expect } from 'vitest';
import { FROZEN_MCP_TOOLS, type FrozenMcpToolName } from '../../src/kernel/contracts/mcp-tools';

describe('MCP tool surface contract', () => {
  it('exactly 3 frozen tools', () => {
    expect(FROZEN_MCP_TOOLS).toHaveLength(3);
  });

  it('tool names are approve/ask/notify with mcp__tlive__ prefix', () => {
    const names = FROZEN_MCP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['mcp__tlive__approve', 'mcp__tlive__ask', 'mcp__tlive__notify']);
  });

  it('each tool has name + description + inputSchema', () => {
    for (const t of FROZEN_MCP_TOOLS) {
      expect(t.name).toMatch(/^mcp__tlive__/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('FrozenMcpToolName type is union of 3 string literals', () => {
    const a: FrozenMcpToolName = 'mcp__tlive__approve';
    const b: FrozenMcpToolName = 'mcp__tlive__ask';
    const c: FrozenMcpToolName = 'mcp__tlive__notify';
    expect([a, b, c]).toHaveLength(3);
  });
});
