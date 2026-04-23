// src/mcp/client-config.ts
//
// Helpers to produce config patches for downstream IDEs / agents to wire
// the tlive-self MCP server. T10 installer consumes these to generate:
//   - ~/.claude/settings.json  (claudeSettingsPatch)
//   - ~/.codex/config.toml     (codexConfigPatch)
//
// All helpers are pure: take inputs, return strings / objects. Writing to
// disk happens in the installer.

export interface TliveSelfClientConfig {
  /** How to invoke `tlive mcp`. Typically `["tlive", "mcp"]` from $PATH. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Human-friendly label surfaced in Claude CLI / Codex. */
  label?: string;
}

/** Merge-ready patch for ~/.claude/settings.json. */
export function claudeSettingsPatch(cfg: TliveSelfClientConfig): Record<string, unknown> {
  return {
    mcpServers: {
      'tlive-self': {
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env ?? {},
      },
    },
  };
}

/**
 * Returns a TOML snippet (string) that can be appended to ~/.codex/config.toml.
 * Codex uses `[mcp_servers.<name>]` sections with `command` + `args` keys.
 */
export function codexConfigPatch(cfg: TliveSelfClientConfig): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('[mcp_servers.tlive-self]');
  lines.push(`command = ${JSON.stringify(cfg.command)}`);
  if (cfg.args && cfg.args.length > 0) {
    lines.push(`args = ${JSON.stringify(cfg.args)}`);
  }
  if (cfg.env && Object.keys(cfg.env).length > 0) {
    lines.push('[mcp_servers.tlive-self.env]');
    for (const [k, v] of Object.entries(cfg.env)) {
      lines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Merge patch into target in-place (used by tests + installer). */
export function mergeJsonPatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      target[k] = mergeJsonPatch(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
  return target;
}
