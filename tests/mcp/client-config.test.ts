// tests/mcp/client-config.test.ts
//
// Client config patch helpers.

import { describe, it, expect } from 'vitest';
import { claudeSettingsPatch, codexConfigPatch, mergeJsonPatch } from '../../src/mcp/client-config.js';

describe('client-config', () => {
  it('claudeSettingsPatch nests tlive-self entry', () => {
    const p = claudeSettingsPatch({ command: 'tlive', args: ['mcp'] });
    expect(p.mcpServers).toEqual({
      'tlive-self': { command: 'tlive', args: ['mcp'], env: {} },
    });
  });

  it('codexConfigPatch renders TOML', () => {
    const t = codexConfigPatch({ command: 'tlive', args: ['mcp'], env: { FOO: 'bar' } });
    expect(t).toContain('[mcp_servers.tlive-self]');
    expect(t).toContain('command = "tlive"');
    expect(t).toContain('args = ["mcp"]');
    expect(t).toContain('FOO = "bar"');
  });

  it('mergeJsonPatch deep merges nested maps', () => {
    const target = { mcpServers: { other: { command: 'x' } } } as Record<string, unknown>;
    const patch = { mcpServers: { 'tlive-self': { command: 'tlive' } } } as Record<string, unknown>;
    const out = mergeJsonPatch(target, patch);
    expect(out).toEqual({
      mcpServers: {
        other: { command: 'x' },
        'tlive-self': { command: 'tlive' },
      },
    });
  });
});
