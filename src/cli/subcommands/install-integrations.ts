// src/cli/subcommands/install-integrations.ts
//
// Add tlive MCP server entry to ~/.claude/mcp.json and ~/.codex/config.json.
// (Idempotent: skips if already present.)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface McpConfig {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}

export async function runInstallIntegrations(_argv: string[]): Promise<void> {
  // Claude
  const claudeDir = join(homedir(), '.claude');
  const claudeMcpPath = join(claudeDir, 'mcp.json');
  mkdirSync(claudeDir, { recursive: true });
  const claudeCfg: McpConfig = existsSync(claudeMcpPath) ? JSON.parse(readFileSync(claudeMcpPath, 'utf-8')) : {};
  claudeCfg.mcpServers ??= {};
  claudeCfg.mcpServers.tlive = { command: 'tlive', args: ['mcp'] };
  writeFileSync(claudeMcpPath, JSON.stringify(claudeCfg, null, 2));
  process.stdout.write(`✓ Wrote ${claudeMcpPath} (tlive MCP server entry added)\n`);

  // Codex (similar — codex uses ~/.codex/config.toml or .json depending on version)
  const codexDir = join(homedir(), '.codex');
  const codexMcpPath = join(codexDir, 'mcp.json');
  if (existsSync(codexDir)) {
    const codexCfg: McpConfig = existsSync(codexMcpPath) ? JSON.parse(readFileSync(codexMcpPath, 'utf-8')) : {};
    codexCfg.mcpServers ??= {};
    codexCfg.mcpServers.tlive = { command: 'tlive', args: ['mcp'] };
    writeFileSync(codexMcpPath, JSON.stringify(codexCfg, null, 2));
    process.stdout.write(`✓ Wrote ${codexMcpPath}\n`);
  } else {
    process.stdout.write(`(skipping codex: ${codexDir} does not exist)\n`);
  }

  process.stdout.write('\nReminder: also set --permission-prompt-tool=mcp__tlive__approve when launching claude.\n');
}
