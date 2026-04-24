#!/usr/bin/env node
// tlive CLI dispatcher — v1.0.
//
// Thin shim around the built `dist/src/tlive-<name>.mjs` subcommands. See
// `docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md` §12 for
// the canonical surface. Dispatch table:
//
//   tlive start                  -> tlive-start.mjs
//   tlive stop-daemon            -> tlive-stop-daemon.mjs
//   tlive status                 -> tlive-status.mjs
//   tlive doctor                 -> tlive-doctor.mjs
//   tlive setup                  -> tlive-setup.mjs
//   tlive version                -> tlive-version.mjs
//   tlive update                 -> tlive-update.mjs
//   tlive daemon-logs [N]        -> tlive-daemon-logs.mjs
//   tlive list                   -> tlive-list.mjs
//   tlive stop <alias>           -> tlive-stop.mjs
//   tlive logs [-f] <alias>      -> tlive-logs.mjs
//   tlive install-integrations   -> tlive-install-integrations.mjs
//   tlive mcp                    -> tlive-mcp.mjs
//
// Legacy (v0.x) commands — `claude`, `codex`, `resume`, `install-hooks`,
// `hooks` — have been removed. Users drive sessions via IM / MCP now.
// `handoff` and `takeback` are v1.0 commands (thin IPC wrappers, see
// src/cli/handoff.ts + takeback.ts).

import { spawnSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, openSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';

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
  start: 'start',
  'stop-daemon': 'stop-daemon',
  status: 'status',
  doctor: 'doctor',
  setup: 'setup',
  version: 'version',
  update: 'update',
  'daemon-logs': 'daemon-logs',
  list: 'list',
  stop: 'stop',
  logs: 'logs',
  'install-integrations': 'install-integrations',
  mcp: 'mcp',
  handoff: 'handoff',
  takeback: 'takeback',
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

Daemon management:
  tlive start [--foreground|-F]    Start the daemon (detaches by default;
                                   -F keeps it in the foreground for debug)
  tlive stop-daemon                Stop the daemon gracefully
  tlive status                     Daemon + session snapshot
  tlive doctor                     Structured health checks
  tlive daemon-logs [N] [--follow] Tail the daemon log

Sessions (runtime slots in the daemon):
  tlive list                       Show live runtime slots
  tlive stop <alias>               Force-kill one runtime slot
  tlive logs <alias> [--follow]    Tail a session's NotificationEvent stream

Handoff (daemon ↔ local claude/codex):
  tlive handoff <alias>            Release to local claude --resume <sdkId>
  tlive takeback <sdkId>           Daemon re-adopts a locally-driven session

Wizards:
  tlive setup                      Git-aware first-time / add-workspace wizard
  tlive install-integrations [all|claude|codex]
                                   Install Claude skill / Codex prompt + MCP entry

MCP:
  tlive mcp                        stdio MCP server (invoked by Claude/Codex)

Meta:
  tlive version                    Print version and optional update hint
  tlive update                     npm install -g tlive@latest

Chat / sessions are driven via IM (Telegram / Discord / Feishu) or via MCP
(Companion mode). The CLI only manages the daemon.
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

  // Short-circuit: if a daemon is already up on the socket, report it.
  const home = process.env.TLIVE_HOME || join(homedir(), '.tlive');
  const sockPath = process.env.TLIVE_SOCKET_PATH || defaultSocketPath(home);
  if (await socketReady(sockPath, 200)) {
    process.stdout.write(`tlive daemon already running (socket ${sockPath})\n`);
    process.exit(0);
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

if (command === 'start') {
  // Do NOT fall through to the generic DISPATCH runEntry — the async
  // detach scheduler lets sync control flow continue, and without this
  // guard `tlive start` would ALSO fire foreground tlive-start.mjs.
  startDaemonDetached(args).catch((err) => {
    process.stderr.write(`tlive start failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
} else {
  const target = DISPATCH[command];
  if (target) {
    runEntry(target, args);
  }
}

// Typo hint
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
