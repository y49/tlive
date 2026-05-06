#!/usr/bin/env node
// tlive CLI dispatcher — v1.0.
//
// Thin shim around the built `dist/src/tlive-<name>.mjs` subcommands. See
// `docs/superpowers/specs/2026-04-24-cli-surface-cleanup-design.md` for
// the canonical surface. Dispatch table:
//
//   Daemon lifecycle:
//     tlive start [-F|--foreground] -> tlive-start.mjs
//     tlive stop                    -> tlive-stop.mjs (daemon shutdown)
//     tlive restart                 -> tlive-restart.mjs (stop+start, no race)
//     tlive status                  -> tlive-status.mjs
//     tlive doctor                  -> tlive-doctor.mjs
//     tlive daemon-logs [N] [-f]    -> tlive-daemon-logs.mjs
//
//   Handoff:
//     tlive handoff <alias>         -> tlive-handoff.mjs
//     tlive takeback <sdkId>        -> tlive-takeback.mjs
//
//   MCP / wizards / meta:
//     tlive mcp                     -> tlive-mcp.mjs
//     tlive setup                   -> tlive-setup.mjs
//     tlive install-integrations    -> tlive-install-integrations.mjs
//     tlive version                 -> tlive-version.mjs
//     tlive update                  -> tlive-update.mjs
//
// Removed in this release: `list`, `logs <alias>`, `stop <alias>`,
// `stop-daemon`. Session-level interaction lives in IM now (see
// `docs/commands.md`). `stop-daemon` was renamed to `stop`.

import { spawnSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, openSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Liveness helpers — duplicated in src/cli/_liveness.ts for the built CLI
// surfaces. Kept inline here so this dispatcher has zero compiled deps.
// ---------------------------------------------------------------------------

/** True iff a process with `pid` is alive. Cross-platform via signal 0. */
function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

/** Read `daemon.pid` and return a numeric PID or null. */
function readDaemonPidSync(pidFile) {
  if (!existsSync(pidFile)) return null;
  try {
    const n = Number(readFileSync(pidFile, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** Best-effort unlink. */
function unlinkIfExists(path) {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..');

const [,, command, ...args] = process.argv;

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

/**
 * Map subcommand → dist entry name. Each entry name corresponds to a file
 * `dist/src/tlive-<entry>.mjs` produced by `scripts/build.mjs`.
 */
const DISPATCH = {
  // `start` is dispatched ahead of this table (see the if/else chain at
  // the bottom of the file); the entry stays here so it participates in
  // the typo-suggestion KNOWN set below.
  start: 'start',
  stop: 'stop',
  restart: 'restart',
  status: 'status',
  doctor: 'doctor',
  'daemon-logs': 'daemon-logs',
  handoff: 'handoff',
  takeback: 'takeback',
  workspace: 'workspace',
  mcp: 'mcp',
  setup: 'setup',
  'install-integrations': 'install-integrations',
  version: 'version',
  update: 'update',
};

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;
  } catch { return 'unknown'; }
}

function entryFor(name) {
  return join(PACKAGE_ROOT, 'dist', 'src', `tlive-${name}.mjs`);
}

function runEntry(name, argv) {
  const entry = entryFor(name);
  if (!existsSync(entry)) {
    process.stderr.write(`tlive: ${entry} not found. Run: npm run build\n`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [entry, ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

const HELP_TEXT = `tlive v${getVersion()} — MCP-native agent fabric for IM

Usage: tlive <command> [args]

Daemon lifecycle:
  tlive start [--foreground|-F]    Start the daemon (detaches by default;
                                   -F keeps it in the foreground for debug)
  tlive stop                       Stop the daemon gracefully (blocks on exit)
  tlive restart                    Atomic stop+start (no socket race)
  tlive status                     Daemon + session snapshot
  tlive doctor                     Structured health checks
  tlive daemon-logs [N] [--follow] Tail the daemon log

Handoff (daemon <-> local claude/codex):
  tlive handoff <alias>            Release a session to local claude --resume
  tlive takeback <sdkSessionId>    Daemon re-adopts a locally-driven session

Workspaces:
  tlive workspace add [<path>]     Register a workspace (path defaults to cwd)
  tlive workspace list             List all registered workspaces
  tlive workspace remove <id|name> Remove a workspace (use -y to skip prompt)

Wizards:
  tlive setup                      Git-aware first-time / add-workspace wizard
  tlive install-integrations [all|claude|codex]
                                   Install Claude skill / Codex prompt + MCP entry

MCP:
  tlive mcp                        stdio MCP server (invoked by Claude/Codex)

Meta:
  tlive version                    Print version and optional update hint
  tlive update                     npm install -g tlive@latest

Chat, session management, permissions — all driven via IM (Telegram /
Discord / Feishu) or via MCP. The CLI only manages the daemon.
`;

if (!command || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}

if (command === '-v' || command === '-V' || command === '--version') {
  process.stdout.write(`${getVersion()}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Known legacy commands — emit a migration hint rather than a "not found".
// ---------------------------------------------------------------------------

const LEGACY_REMOVED = {
  claude: 'Drive Claude sessions via IM, `claude` CLI directly, or via MCP. See README.',
  codex: 'Drive Codex sessions via IM, `codex` CLI directly, or via MCP. See README.',
  resume: 'Use IM `/resume <alias>`, or `claude --resume <sdkSessionId>` in a terminal.',
  'install-hooks': 'Hooks bridge removed. Use `tlive install-integrations`.',
  hooks: 'Hooks bridge removed. Use MCP permissions via `mcp__tlive__approve`.',
  list: 'Use IM `/sessions` to list runtime slots. The CLI no longer manages sessions.',
  logs: 'Use `tlive daemon-logs [--follow]` (grep by alias if needed). Per-session CLI logs were removed in v1.0.',
  'stop-daemon': 'Renamed to `tlive stop` — `start` and `stop` now target the daemon symmetrically.',
  install: (() => {
    const sub = args[0];
    if (sub === 'skills') return 'Use `tlive install-integrations` (all|claude|codex).';
    return 'Use `tlive install-integrations`.';
  })(),
};

if (LEGACY_REMOVED[command] !== undefined) {
  process.stderr.write(`tlive: \`${command}\` was removed in v1.0.\n`);
  process.stderr.write(`${LEGACY_REMOVED[command]}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// `tlive start` — detach to background (the Unix daemon convention)
// ---------------------------------------------------------------------------

function defaultSocketPath(home) {
  // POSIX: filesystem path; Windows: Node's named-pipe syntax. Both are
  // consumable by the same `net` API on their respective platforms.
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\tlive-daemon'
    : join(home, 'daemon.sock');
}

async function startDaemonDetached(argv) {
  const foreground = argv.includes('--foreground') || argv.includes('-F');

  const home = process.env.TLIVE_HOME || join(homedir(), '.tlive');
  const sockPath = process.env.TLIVE_SOCKET_PATH || defaultSocketPath(home);
  const pidFile = join(home, 'daemon.pid');

  // Authoritative liveness check: the daemon is "running" iff its PID is
  // alive in the OS process table. Socket-presence and pid-file-presence
  // both linger after a crash AND while a graceful shutdown is mid-flight
  // (the socket stays bound until ipc.close fires near the end of the
  // teardown chain). Trusting the socket for liveness was the source of
  // the `tlive stop && tlive start` race.
  const pid = readDaemonPidSync(pidFile);
  if (pid !== null && isPidAlive(pid)) {
    process.stdout.write(`tlive daemon already running (pid ${pid}, socket ${sockPath})\n`);
    process.exit(0);
  }

  // PID file points at a dead process → zombie left over from a crash or
  // ungraceful exit. Clean up before spawning so the new daemon can claim
  // a fresh socket and pid path.
  if (pid !== null) {
    process.stderr.write(`tlive: cleaning stale pid file (${pid} is dead)\n`);
    unlinkIfExists(pidFile);
  }
  // Stale socket can exist independently (crash before pidfile written, or
  // bootstrap unlink failed). Drop it so net.createServer doesn't EADDRINUSE.
  if (existsSync(sockPath)) {
    process.stderr.write(`tlive: cleaning stale socket ${sockPath}\n`);
    unlinkIfExists(sockPath);
  }

  if (foreground) {
    // Debug mode: run in the current terminal, operator uses Ctrl-C.
    runEntry('start', argv.filter((a) => a !== '--foreground' && a !== '-F'));
    return;
  }

  // Detached: spawn tlive-daemon.mjs with stdio redirected to a log file.
  const entry = entryFor('daemon');
  if (!existsSync(entry)) {
    process.stderr.write(`tlive: ${entry} not found. Run: npm run build\n`);
    process.exit(1);
  }
  mkdirSync(home, { recursive: true });
  const logPath = join(home, 'daemon.log');
  const logFd = openSync(logPath, 'a');
  // `detached: true` semantics differ per platform:
  //   - POSIX: child becomes its own session leader (setsid), parent can exit.
  //   - Windows: without `windowsHide` this opens a visible console window
  //     for the daemon. We want a fully background process, so hide it.
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
    windowsHide: true,
  });
  child.unref();

  // Wait up to ~5s for the daemon to bind its socket before returning.
  const ready = await waitForSocket(sockPath, 5000);
  if (!ready) {
    process.stderr.write(
      `tlive: daemon did not come up within 5s (log: ${logPath}).\n` +
      `Check \`tlive daemon-logs 200\` or tail ${logPath}.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `tlive daemon started (pid ${child.pid}, socket ${sockPath}, log ${logPath})\n`,
  );
  process.exit(0);
}

function socketReady(path, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection(path);
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.end(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function waitForSocket(path, totalMs) {
  const stepMs = 100;
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await socketReady(path, 200)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// `tlive stop` used to take a session alias; in v1.0 it means daemon-stop.
// Reject extra args up-front with a clear hint pointing at IM.
if (command === 'stop' && args.length > 0) {
  process.stderr.write(
    'tlive stop no longer accepts a session argument.\n' +
    'Use IM `/kill` to terminate a specific session.\n',
  );
  process.exit(2);
}

if (command === 'start') {
  // Do NOT fall through to the typo block below — the async detach scheduler
  // lets sync control flow continue, and without this guard `tlive start`
  // would also hit `process.exit(1)` in the unknown-command branch before
  // the detached daemon comes up.
  startDaemonDetached(args).catch((err) => {
    process.stderr.write(`tlive start failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
} else if (DISPATCH[command]) {
  runEntry(DISPATCH[command], args);
} else {
  // Typo hint for unknown commands
  const KNOWN = Object.keys(DISPATCH);
  const similar = KNOWN.find((k) => {
    if (Math.abs(k.length - command.length) > 2) return false;
    let diff = 0;
    for (let i = 0; i < Math.max(k.length, command.length); i++) {
      if (k[i] !== command[i]) diff++;
    }
    return diff <= 2 && diff > 0;
  });
  process.stderr.write(`tlive: unknown command \`${command}\`\n`);
  if (similar) process.stderr.write(`Did you mean: tlive ${similar}?\n`);
  else process.stderr.write('Run: tlive --help\n');
  process.exit(1);
}
