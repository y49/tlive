// src/cli/main.ts
//
// Single-entry tlive CLI. Internal dispatch with lazy import per subcommand
// to keep startup fast.

import { FROZEN_CLI_SUBCOMMANDS, type FrozenSubcommand } from '../kernel/contracts/cli-surface.js';

const HELP = `tlive — hook approval/notification layer for Claude Code / Codex

Usage: tlive <subcommand> [args]

Daemon lifecycle:
  start, stop, restart, status, doctor, daemon-logs

Hook integration:
  hook <event>              — Claude hook shim (reads stdin, outputs decision)
  install-integrations      — write ~/.claude/settings.json hooks (idempotent)
  approve <requestId>       — approve a pending permission (CLI fallback)

Workspaces:
  workspace add|list|remove

Wizards:
  setup

Meta:
  version, update
`;

export async function runCli(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help' || subcommand === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (!(FROZEN_CLI_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    process.stderr.write(`tlive: unknown subcommand '${subcommand}'\n`);
    process.exit(1);
  }
  const name = subcommand as FrozenSubcommand;
  switch (name) {
    case 'start': { const { runStart } = await import('./subcommands/start.js'); return runStart(rest); }
    case 'stop': { const { runStop } = await import('./subcommands/stop.js'); return runStop(rest); }
    case 'restart': { const { runRestart } = await import('./subcommands/restart.js'); return runRestart(rest); }
    case 'status': { const { runStatus } = await import('./subcommands/status.js'); return runStatus(rest); }
    case 'doctor': { const { runDoctor } = await import('./subcommands/doctor.js'); return runDoctor(rest); }
    case 'daemon-logs': { const { runDaemonLogs } = await import('./subcommands/daemon-logs.js'); return runDaemonLogs(rest); }
    case 'handoff': { const { runHandoff } = await import('./subcommands/handoff.js'); return runHandoff(rest); }
    case 'approve': { const { runApprove } = await import('./subcommands/approve.js'); return runApprove(rest); }
    case 'workspace': { const { runWorkspace } = await import('./subcommands/workspace.js'); return runWorkspace(rest); }
    case 'setup': { const { runSetup } = await import('./subcommands/setup.js'); return runSetup(rest); }
    case 'install-integrations': { const { runInstallIntegrations } = await import('./subcommands/install-integrations.js'); return runInstallIntegrations(rest); }
    case 'hook': { const { runHook } = await import('./subcommands/hook.js'); return runHook(rest); }
    case 'version': { const { runVersion } = await import('./subcommands/version.js'); return runVersion(rest); }
    case 'update': { const { runUpdate } = await import('./subcommands/update.js'); return runUpdate(rest); }
  }
}

if (process.argv[1]?.endsWith('tlive-cli.mjs') || process.argv[1]?.endsWith('cli.js')) {
  runCli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`tlive: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
