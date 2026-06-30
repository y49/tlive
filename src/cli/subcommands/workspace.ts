// src/cli/subcommands/workspace.ts
// Workspace routing was removed in v2.1 (single-user model, no workspace binding).

export async function runWorkspace(_argv: string[]): Promise<void> {
  process.stderr.write('tlive workspace: workspace routing has been removed in v2.1.\n');
  process.exit(1);
}
