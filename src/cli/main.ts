// src/cli/main.ts
import { readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLI_SUBCOMMANDS, type Subcommand } from '../kernel/contracts/cli-surface.js';

const HELP = `tlive — vendor-neutral hook approval + web terminal for Claude Code / Codex

Usage: tlive <subcommand> [args]   |   tlive --version

  setup              configure IM + install Claude/Codex hooks
                     (--hooks-only reinstalls hooks only; add --claude / --codex to pick vendors)
  start | stop       daemon lifecycle (IPC + IM + web; auto-starts with new agent
                     sessions — set daemon.autoStart:false to disable)
  status             health, configured destinations, paths
  logs [-f]          tail the daemon log
  run <cmd> [args]   wrap a process: local terminal + web terminal
  url                print the web dashboard URL + a QR code (for scanning)
  hook [--codex] <event>  hook shim (invoked by Claude/Codex hooks; --codex = Codex decision wire)
`;

function printVersion(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    process.stdout.write(`${pkg.version ?? 'unknown'}\n`);
  } catch {
    process.stdout.write('unknown\n');
  }
}

export async function runCli(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
    printVersion();
    return;
  }
  if (!subcommand || subcommand === '-h' || subcommand === '--help' || subcommand === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (!(CLI_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    process.stderr.write(`tlive: unknown subcommand '${subcommand}'\n`);
    process.exit(1);
  }
  const name = subcommand as Subcommand;
  switch (name) {
    case 'setup': { const { runSetup } = await import('./subcommands/setup.js'); return runSetup(rest); }
    case 'start': { const { runStart } = await import('./subcommands/start.js'); return runStart(rest); }
    case 'stop': { const { runStop } = await import('./subcommands/stop.js'); return runStop(rest); }
    case 'status': { const { runStatus } = await import('./subcommands/status.js'); return runStatus(rest); }
    case 'logs': { const { runLogs } = await import('./subcommands/logs.js'); return runLogs(rest); }
    case 'run': { const { runRun } = await import('./subcommands/run.js'); return runRun(rest); }
    case 'url': { const { runUrl } = await import('./subcommands/url.js'); return runUrl(rest); }
    case 'hook': { const { runHook } = await import('./subcommands/hook.js'); return runHook(rest); }
  }
}

// Run when invoked as the program entry. argv[1] is the invoked path — which,
// for a globally-installed/linked `bin`, is a SYMLINK (e.g. ~/.local/bin/tlive),
// so a filename check fails. Resolve the symlink and compare to this module.
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
if (isMain()) {
  // `tlive status | head` closes the pipe early — exit quietly instead of crashing.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); });
  runCli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`tlive: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
