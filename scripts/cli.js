#!/usr/bin/env node
// TermLive CLI entry point
import { execSync, spawn, spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, chmodSync, openSync, closeSync, copyFileSync, statSync, readSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [,, command, ...args] = process.argv;

const SCRIPTS_DIR = __dirname;
const PACKAGE_ROOT = join(__dirname, '..');
const isWindows = process.platform === 'win32';
const TLIVE_HOME = join(homedir(), '.tlive');
const RUNTIME_DIR = join(TLIVE_HOME, 'runtime');
const LOG_DIR = join(TLIVE_HOME, 'logs');
const BRIDGE_PID = join(RUNTIME_DIR, 'bridge.pid');
const BRIDGE_ENTRY = join(PACKAGE_ROOT, 'bridge', 'dist', 'main.mjs');
const CONFIG_FILE = join(TLIVE_HOME, 'config.env');
const CORE_BIN = join(TLIVE_HOME, 'bin', isWindows ? 'tlive-core.exe' : 'tlive-core');

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;
  } catch { return 'unknown'; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse ~/.tlive/config.env (KEY=VALUE lines, supports quotes) */
function loadConfigEnv() {
  const env = {};
  if (!existsSync(CONFIG_FILE)) return env;
  const content = readFileSync(CONFIG_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const raw = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    let val = raw.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

/** Check whether a PID is alive */
function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM = process exists but no permission (treat as running)
    if (e.code === 'EPERM') return true;
    return false;
  }
}

/** Read bridge.pid and return PID if alive, else null */
function getBridgePid() {
  if (!existsSync(BRIDGE_PID)) return null;
  try {
    const pid = parseInt(readFileSync(BRIDGE_PID, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    return isProcessRunning(pid) ? pid : null;
  } catch { return null; }
}

/** Ensure runtime and log directories exist */
function ensureDirs() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Daemon functions
// ---------------------------------------------------------------------------

function daemonStart() {
  ensureDirs();

  const existing = getBridgePid();
  if (existing) {
    console.log(`Bridge is already running (PID ${existing})`);
    return;
  }

  if (!existsSync(BRIDGE_ENTRY)) {
    console.error('ERROR: Bridge not built.');
    console.error(`Build: cd ${join(PACKAGE_ROOT, 'bridge')} && npm install && npm run build`);
    process.exit(1);
  }

  const config = loadConfigEnv();
  const runtime = process.env.TL_RUNTIME || config.TL_RUNTIME || 'claude';

  console.log(`Starting Bridge (runtime: ${runtime})...`);

  const logFile = join(LOG_DIR, 'bridge.log');
  const logFd = openSync(logFile, 'a');

  const env = {
    ...process.env,
    ...config,
    TL_RUNTIME: runtime,
    TL_DEFAULT_WORKDIR: process.env.TL_DEFAULT_WORKDIR || process.cwd(),
  };

  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });

  writeFileSync(BRIDGE_PID, String(child.pid));
  child.unref();
  closeSync(logFd);

  console.log(`Bridge started (PID ${child.pid})`);
}

function daemonStop() {
  const pid = getBridgePid();
  if (pid) {
    console.log(`Stopping Bridge (PID ${pid})...`);
    try { process.kill(pid); } catch {}
    try { unlinkSync(BRIDGE_PID); } catch {}
    console.log('Bridge stopped.');
  } else {
    console.log('Bridge is not running.');
    // Clean up stale pid file
    try { unlinkSync(BRIDGE_PID); } catch {}
  }
}

async function daemonStatus() {
  console.log('=== TLive Status ===');

  const config = loadConfigEnv();
  const runtime = process.env.TL_RUNTIME || config.TL_RUNTIME || 'claude';
  const pid = getBridgePid();

  if (pid) {
    console.log(`Bridge:       running (PID ${pid}, runtime: ${runtime})`);
  } else {
    console.log('Bridge:       not running');
  }

  // Check Go Core web terminal
  const port = process.env.TL_PORT || config.TL_PORT || '4590';
  const token = process.env.TL_TOKEN || config.TL_TOKEN || '';
  try {
    const resp = await fetch(`http://localhost:${port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      console.log(`Web terminal: running at http://localhost:${port}`);
    } else {
      console.log('Web terminal: not running (start with: tlive <cmd>)');
    }
  } catch {
    console.log('Web terminal: not running (start with: tlive <cmd>)');
  }
}

function daemonLogs(n = 50) {
  const logFile = join(LOG_DIR, 'bridge.log');
  console.log(`=== Bridge (last ${n} lines) ===`);
  if (!existsSync(logFile)) {
    console.log('(no log file)');
    return;
  }
  try {
    const size = statSync(logFile).size;
    // Read at most last 128KB to avoid OOM on huge logs
    const MAX_READ = 128 * 1024;
    let content;
    if (size > MAX_READ) {
      const fd = openSync(logFile, 'r');
      const buf = Buffer.alloc(MAX_READ);
      readSync(fd, buf, 0, MAX_READ, size - MAX_READ);
      closeSync(fd);
      content = buf.toString('utf-8');
      // Drop first partial line
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) content = content.slice(firstNewline + 1);
    } else {
      content = readFileSync(logFile, 'utf-8');
    }
    const lines = content.trimEnd().split('\n').slice(-n);
    console.log(lines.join('\n'));
  } catch {
    console.log('(no log file)');
  }
}

// ---------------------------------------------------------------------------
// ensureBridgeRunning — silent auto-start for Go Core wrapping
// ---------------------------------------------------------------------------

function ensureBridgeRunning() {
  if (getBridgePid()) return; // already running
  if (!existsSync(CONFIG_FILE)) return; // no config, skip

  ensureDirs();

  if (!existsSync(BRIDGE_ENTRY)) return;

  const config = loadConfigEnv();
  const runtime = process.env.TL_RUNTIME || config.TL_RUNTIME || 'claude';
  const logFile = join(LOG_DIR, 'bridge.log');
  const logFd = openSync(logFile, 'a');

  const env = {
    ...process.env,
    ...config,
    TL_RUNTIME: runtime,
    TL_DEFAULT_WORKDIR: process.env.TL_DEFAULT_WORKDIR || process.cwd(),
  };

  try {
    const child = spawn(process.execPath, [BRIDGE_ENTRY], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env,
    });
    writeFileSync(BRIDGE_PID, String(child.pid));
    child.unref();
    closeSync(logFd);
    console.log('  Bridge auto-started in background');
  } catch (e) {
    console.error(`  Bridge auto-start failed: ${e.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

async function runDoctor() {
  console.log('=== TermLive Doctor ===\n');

  // Dependencies
  console.log('Dependencies:');

  console.log(`  node:    ${process.version}`);

  const checkCmd = (name) => {
    try {
      const r = spawnSync(isWindows ? 'where' : 'which', [name], { encoding: 'utf-8', timeout: 5000 });
      return r.status === 0;
    } catch { return false; }
  };

  const gitVersion = (() => {
    try {
      const r = spawnSync('git', ['--version'], { encoding: 'utf-8', timeout: 5000 });
      return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
    } catch { return null; }
  })();

  console.log(checkCmd('curl') ? '  curl:    OK' : '  curl:    NOT FOUND (optional)');
  console.log(checkCmd('jq') ? '  jq:      OK' : '  jq:      NOT FOUND (optional)');
  console.log(gitVersion ? `  git:     ${gitVersion}` : '  git:     NOT FOUND');

  console.log('');

  // Go Core binary
  console.log('Go Core:');
  if (existsSync(CORE_BIN)) {
    console.log(`  binary:  OK (${CORE_BIN})`);
  } else {
    console.log('  binary:  NOT FOUND');
  }

  console.log('');

  // Config
  console.log('Config:');
  if (existsSync(CONFIG_FILE)) {
    console.log('  config.env: OK');
    const config = loadConfigEnv();
    console.log(config.TL_TOKEN ? '  TL_TOKEN: set' : '  TL_TOKEN: NOT SET');
    console.log(config.TL_TG_BOT_TOKEN ? '  Telegram: configured' : '  Telegram: not configured');
    console.log(config.TL_DC_BOT_TOKEN ? '  Discord:  configured' : '  Discord:  not configured');
    console.log(config.TL_FS_APP_ID ? '  Feishu:   configured' : '  Feishu:   not configured');
  } else {
    console.log("  config.env: NOT FOUND (run 'npx tlive setup')");
  }

  console.log('');

  // Processes
  console.log('Processes:');
  const bridgePid = getBridgePid();
  console.log(bridgePid ? `  Bridge:   running (PID ${bridgePid})` : '  Bridge:   not running');

  console.log('');

  // API check
  const config = existsSync(CONFIG_FILE) ? loadConfigEnv() : {};
  const port = process.env.TL_PORT || config.TL_PORT || '4590';
  const token = process.env.TL_TOKEN || config.TL_TOKEN || '';
  try {
    const resp = await fetch(`http://localhost:${port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const body = await resp.text();
      console.log('API:');
      console.log(body);
    } else {
      console.log(`API: unreachable (port ${port})`);
    }
  } catch {
    console.log(`API: unreachable (port ${port})`);
  }

  console.log('');

  // Hook scripts (in npm package directory)
  console.log('Hooks:');
  for (const name of ['hook-handler.mjs', 'notify-handler.mjs', 'stop-handler.mjs']) {
    const p = join(SCRIPTS_DIR, name);
    console.log(existsSync(p) ? `  ${name}: OK` : `  ${name}: NOT FOUND`);
  }

  // hooks-paused
  const pauseFile = join(TLIVE_HOME, 'hooks-paused');
  console.log(existsSync(pauseFile) ? '  status: paused (auto-allow)' : '  status: active');

  console.log('\n=== Done ===');
}

// ---------------------------------------------------------------------------
// Go Core forwarding
// ---------------------------------------------------------------------------

function runCore(coreArgs) {
  if (!existsSync(CORE_BIN)) {
    console.error(`Go Core not found at ${CORE_BIN}`);
    console.error('Run: npm run setup:core');
    process.exit(1);
  }
  ensureBridgeRunning();
  const result = spawnSync(CORE_BIN, coreArgs, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const HELP_TEXT = `TLive — Terminal live monitoring + IM bridge for AI coding tools

Usage:
  tlive <cmd> [args]         Wrap any command with web terminal
  tlive <subcommand>         Manage TLive services

Web Terminal:
  tlive claude               Wrap Claude Code with web-accessible terminal
  tlive python train.py      Wrap any long-running command
  tlive npm run build        Access from phone browser via QR code

Setup (one-time):
  tlive setup                Configure IM platforms (Telegram/Discord/Feishu)
  tlive install skills       Install /tlive skill + hooks to Claude Code

Service Management:
  tlive start [--runtime R]  Start IM Bridge (R: claude|codex, default: claude)
  tlive stop                 Stop IM Bridge daemon
  tlive status               Show Bridge + Web Terminal status
  tlive logs [N]             Show last N log lines (default: 50)
  tlive doctor               Run diagnostic checks
  tlive update               Update to latest version
  tlive version              Show version info

Hook Control:
  tlive hooks                Show hook approval status
  tlive hooks pause          Auto-allow all, no IM notifications
  tlive hooks resume         Resume IM approval flow

IM Commands (in Telegram/Discord/Feishu):
  /new                       New conversation
  /runtime claude|codex      Switch AI provider
  /perm on|off               Permission prompts
  /effort low|medium|high|max  Thinking depth
  /stop                      Interrupt execution
  /verbose 0|1               Detail level (0=quiet, 1=terminal card)
  /sessions                  List recent sessions
  /session <n>               Switch to session
  /help                      Show all commands

In Claude Code (AI-guided):
  /tlive                     Start Bridge (with pre-checks)
  /tlive setup               Interactive setup wizard
  /tlive reconfigure         Modify specific config fields
  /tlive doctor              Diagnose issues + suggest fixes
`;

const NODE_COMMANDS = new Set(['setup', 'start', 'stop', 'status', 'logs', 'hooks', 'doctor', 'version', 'update']);
const CORE_COMMANDS = new Set(['install']);

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

function showHelp() {
  console.log(HELP_TEXT);
}

// No command or help flags
if (!command || command === '--help' || command === '-h' || command === 'help') {
  showHelp();
  process.exit(0);
}

// Version flags
if (command === '--version' || command === '-v' || command === '-V') {
  console.log(getVersion());
  process.exit(0);
}

switch (command) {
  case 'setup': {
    const setupEntry = join(PACKAGE_ROOT, 'bridge', 'dist', 'setup.mjs');
    if (existsSync(setupEntry)) {
      const r = spawnSync(process.execPath, [setupEntry], { stdio: 'inherit' });
      if (r.status) process.exit(r.status);
    } else {
      console.error('Setup wizard not found. Try reinstalling: npm install -g tlive');
    }
    break;
  }

  case 'start': {
    // Parse --runtime flag
    const rtIdx = args.indexOf('--runtime');
    if (rtIdx !== -1 && args[rtIdx + 1]) {
      const rt = args[rtIdx + 1].toLowerCase();
      if (['claude', 'codex'].includes(rt)) {
        process.env.TL_RUNTIME = rt;
        console.log(`Runtime: ${rt}`);
      } else {
        console.error(`Unknown runtime: ${rt}. Use: claude | codex`);
        process.exit(1);
      }
    }
    daemonStart();
    break;
  }

  case 'stop':
    daemonStop();
    break;

  case 'status':
    await daemonStatus();
    break;

  case 'logs':
    daemonLogs(parseInt(args[0], 10) || 50);
    break;

  case 'hooks': {
    const hooksSub = args[0];
    const pauseFile = join(TLIVE_HOME, 'hooks-paused');
    if (hooksSub === 'pause') {
      mkdirSync(TLIVE_HOME, { recursive: true });
      writeFileSync(pauseFile, '');
      console.log('Hooks paused — all permissions auto-allowed, no notifications.');
    } else if (hooksSub === 'resume') {
      try { unlinkSync(pauseFile); } catch {}
      console.log('Hooks resumed — permissions forwarded to IM.');
    } else {
      const paused = existsSync(pauseFile);
      console.log(`Hooks: ${paused ? '⏸ paused (auto-allow)' : '▶ active'}`);
    }
    break;
  }

  case 'doctor':
    await runDoctor();
    break;

  case 'version': {
    const ver = getVersion();
    const coreExists = existsSync(CORE_BIN);
    let coreVer = 'not installed';
    if (coreExists) {
      try {
        const vFile = join(TLIVE_HOME, 'bin', '.core-version');
        coreVer = readFileSync(vFile, 'utf-8').trim();
      } catch { coreVer = 'unknown'; }
    }
    console.log(`tlive          ${ver}`);
    console.log(`tlive-core     ${coreVer}`);
    console.log(`node           ${process.version}`);
    // Check for updates
    try {
      const latest = execSync('npm view tlive version', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (latest !== ver) {
        console.log(`\nUpdate available: ${ver} → ${latest}`);
        console.log('Run: tlive update');
      } else {
        console.log('\nUp to date.');
      }
    } catch {}
    break;
  }

  case 'update': {
    const current = getVersion();
    console.log(`Current version: ${current}`);
    console.log('Updating...');
    try {
      execSync('npm install -g tlive@latest', { stdio: 'inherit' });
      const updated = execSync('npm view tlive version', { encoding: 'utf-8', timeout: 5000 }).trim();
      console.log(`\nUpdated to ${updated || 'latest'}.`);
      // Restart bridge if running
      if (getBridgePid()) {
        console.log('Restarting bridge...');
        daemonStop();
        daemonStart();
      }
    } catch (err) {
      console.error(`Update failed: ${err.message || err}`);
      process.exit(1);
    }
    break;
  }

  case 'install': {
    const sub = args[0];
    if (sub === 'skills') {
      const target = args.includes('--codex') ? 'codex' : 'claude';
      const skillSrc = join(PACKAGE_ROOT, 'SKILL.md');

      if (!existsSync(skillSrc)) {
        console.error('SKILL.md not found. Try reinstalling: npm install -g tlive');
        process.exit(1);
      }

      // Install SKILL.md
      const skillDir = target === 'codex'
        ? join(homedir(), '.codex', 'skills', 'tlive')
        : join(homedir(), '.claude', 'commands');
      mkdirSync(skillDir, { recursive: true });

      const skillDest = target === 'codex'
        ? join(skillDir, 'SKILL.md')
        : join(skillDir, 'tlive.md');
      copyFileSync(skillSrc, skillDest);
      console.log(`Skill installed: ${skillDest}`);

      // Sync reference docs to ~/.tlive/docs/
      const docsDir = join(TLIVE_HOME, 'docs');
      mkdirSync(docsDir, { recursive: true });
      const refsDir = join(PACKAGE_ROOT, 'references');
      for (const doc of ['setup-guides.md', 'token-validation.md', 'troubleshooting.md']) {
        const refSrc = join(refsDir, doc);
        const dest = join(docsDir, doc);
        if (existsSync(refSrc)) {
          copyFileSync(refSrc, dest);
        }
      }
      console.log(`Reference docs synced: ${docsDir}`);

      // Auto-configure hooks in ~/.claude/settings.json
      if (target === 'claude') {
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        let settings = {};
        if (existsSync(settingsPath)) {
          try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
        }

        if (!settings.hooks) settings.hooks = {};

        // Point hooks directly to npm package scripts — no copy needed
        const hookHandlerCmd = `node "${join(SCRIPTS_DIR, 'hook-handler.mjs')}"`;
        const notifyHandlerCmd = `node "${join(SCRIPTS_DIR, 'notify-handler.mjs')}"`;
        const stopHandlerCmd = `node "${join(SCRIPTS_DIR, 'stop-handler.mjs')}"`;


        // Remove ALL existing TLive hooks (both .sh and .mjs, any path)
        // then re-add with current paths — ensures hooks always point to this install
        const isTliveHook = (cmd) =>
          cmd?.includes('hook-handler') || cmd?.includes('notify-handler') || cmd?.includes('stop-handler');

        for (const hookType of Object.keys(settings.hooks)) {
          settings.hooks[hookType] = (settings.hooks[hookType] || []).filter(e => {
            if (isTliveHook(e.command)) return false;
            if (e.hooks) {
              e.hooks = e.hooks.filter(h => !isTliveHook(h.command));
              return e.hooks.length > 0;
            }
            return true;
          });
          if (settings.hooks[hookType].length === 0) delete settings.hooks[hookType];
        }

        // Add hooks with current paths
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        settings.hooks.PostToolUse.push({
          matcher: 'AskUserQuestion',
          hooks: [{
            type: 'command',
            command: hookHandlerCmd,
            timeout: 10,
          }],
        });

        if (!settings.hooks.PermissionRequest) settings.hooks.PermissionRequest = [];
        settings.hooks.PermissionRequest.push({
          hooks: [{
            type: 'command',
            command: hookHandlerCmd,
            timeout: 300,
          }],
        });

        if (!settings.hooks.Notification) settings.hooks.Notification = [];
        settings.hooks.Notification.push({
          hooks: [{
            type: 'command',
            command: notifyHandlerCmd,
            timeout: 10,
          }],
        });

        if (!settings.hooks.Stop) settings.hooks.Stop = [];
        settings.hooks.Stop.push({
          hooks: [{
            type: 'command',
            command: stopHandlerCmd,
            async: true,
          }],
        });

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log(`Hooks configured in: ${settingsPath}`);
      }
    } else {
      console.log('Usage: tlive install skills [--codex]');
    }
    break;
  }

  default: {
    // Check for typos of known commands before forwarding to Go Core
    const known = ['setup', 'start', 'stop', 'status', 'logs', 'hooks', 'doctor', 'install', 'help', 'version', 'update'];
    const similar = known.find(k => {
      if (Math.abs(k.length - command.length) > 2) return false;
      let diff = 0;
      for (let i = 0; i < Math.max(k.length, command.length); i++) {
        if (k[i] !== command[i]) diff++;
      }
      return diff <= 2 && diff > 0;
    });
    if (similar) {
      console.error(`Unknown command: ${command}`);
      console.error(`Did you mean: tlive ${similar}?`);
      process.exit(1);
    }
    // Unknown command → wrap with Go Core web terminal
    runCore([command, ...args]);
    break;
  }
}
