// src/kernel/permission/risk.ts
//
// Single source of truth for "dangerous operations" — the hard never-auto-allow
// floor. Used two ways, so it must live in one place:
//   1. approval-renderer.ts stamps the ⚠️ Risky line on cards from it.
//   2. policy-engine.ts refuses to auto-allow anything it flags, in ANY mode
//      (even `safe`). No config can lower this floor; only an explicit human
//      `/trust on` overrides it (a deliberate, revocable act).
//
// Vendor-neutral: matches on the normalized tool name + input, never on any
// CC/Codex-specific field.

/** Dangerous shell patterns, each named so the card can point at WHAT is risky
 *  ("rm -rf, sudo") instead of a vague "risky". */
export const RISKY_COMMANDS: Array<{ re: RegExp; name: string }> = [
  { re: /\brm\s+-[rf]/, name: 'rm -rf' },
  { re: /\bsudo\b/, name: 'sudo' },
  { re: /\bcurl\b[^\n]*\|\s*(?:sh|bash)/, name: 'curl | sh' },
  { re: /\bwget\b[^\n]*\|\s*(?:sh|bash)/, name: 'wget | sh' },
  { re: /:\(\)\s*\{/, name: 'fork bomb' },
  { re: /\bmkfs\b/, name: 'mkfs' },
  { re: /\bdd\s+if=/, name: 'dd' },
  { re: /\bchmod\s+(?:-R\s+)?[0-7]*7{2,}/, name: 'chmod 777' },
  { re: /authorized_keys/, name: 'authorized_keys' },
  { re: /\bgit\s+push\b[^\n]*(?:--force|-f)\b/, name: 'git push --force' },
  { re: /\beval\b/, name: 'eval' },
  { re: />\s*\/dev\/sd/, name: 'write to disk' },
];

/** Paths whose modification is treated as dangerous (secrets, shell rc, system
 *  config). A write/edit touching one always cards, even in `safe` mode. */
const SENSITIVE_PATHS: RegExp[] = [
  /(^|\/)\.env(\.|$|\/)/,
  /(^|\/)\.ssh\//,
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_[a-z]+$/,          // id_rsa / id_ed25519 …
  /(^|\/)\.aws\//,
  /(^|\/)\.(bashrc|zshrc|profile|bash_profile|zprofile)$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)credentials(\.|$)/,
  /^\/etc\//,
];

/** Names of the risky patterns a Bash command hits (empty = none). */
export function riskHits(command: string): string[] {
  return RISKY_COMMANDS.filter((r) => r.re.test(command)).map((r) => r.name);
}

const str = (input: unknown, key: string): string | undefined => {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : undefined;
};

/** True if this tool call must never auto-allow (the hard floor). Conservative:
 *  a shape it can't read as safe counts as NOT dangerous here — the policy's
 *  `safe` mode separately refuses unknown/MCP tools, so "not dangerous" does
 *  not by itself mean "auto-allow". */
export function isDangerous(toolName: string, input: unknown): boolean {
  if (toolName === 'Bash') {
    const cmd = str(input, 'command') ?? '';
    return riskHits(cmd).length > 0;
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit' || toolName === 'MultiEdit') {
    const fp = str(input, 'file_path') ?? str(input, 'notebook_path') ?? '';
    return SENSITIVE_PATHS.some((re) => re.test(fp));
  }
  return false;
}
