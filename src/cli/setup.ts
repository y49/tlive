// src/cli/setup.ts — `tlive setup`
//
// Interactive wizard for first-time setup and add-workspace flows. Spec §12
// + §14.
//
// Flow:
//   1. Detect existing config. If v0.x (config.env or missing `version: "1"`),
//      run the loader's migration path which rewrites config.json and backs
//      up the original. Print a one-liner summary.
//   2. Read git context (remote / branch / suggested name) via
//      `src/workspace/git-aware.ts` for the current cwd. Prompt confirm.
//   3. Ask for an IM platform (telegram / feishu / skip). For each
//      selection, prompt for the required credential fields and write them
//      into `channels.<platform>`.
//   4. Persist the merged config as `~/.tlive/config.json` (atomic rename).
//   5. Offer to run `tlive install-integrations all` — dispatched via
//      spawnSync to the sibling CLI entry so the two programs stay separate.
//
// The wizard is intentionally tiny (~300 LOC) and uses readline. When stdin
// is not a TTY (piped / CI), non-interactive mode writes a minimal config
// from the git context and exits.

import { createInterface } from 'node:readline';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config/loader.js';
import { parseConfig, type TliveConfigV1, type WorkspaceConfigEntry } from '../config/schema.js';
import { detectGitContext } from '../workspace/git-aware.js';

interface Io {
  out: (s: string) => void;
  ask: (q: string) => Promise<string>;
  close: () => void;
  tty: boolean;
}

function makeIo(): Io {
  const tty = Boolean(process.stdin.isTTY);
  if (!tty) {
    return {
      out: (s) => process.stdout.write(s),
      ask: async () => '',
      close: () => { /* no-op */ },
      tty: false,
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    out: (s) => process.stdout.write(s),
    ask: (q) => new Promise<string>((resolve) => rl.question(q, (ans) => resolve(ans.trim()))),
    close: () => rl.close(),
    tty: true,
  };
}

async function askWithDefault(io: Io, label: string, def?: string): Promise<string> {
  const suffix = def ? ` [${def}]` : '';
  const a = await io.ask(`${label}${suffix}: `);
  return a || def || '';
}

function nowId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

async function runMigrationIfNeeded(io: Io, home: string): Promise<{ migrated: boolean }> {
  const envPath = join(home, 'config.env');
  const jsonPath = join(home, 'config.json');
  const hasLegacy = existsSync(envPath);
  const hasJson = existsSync(jsonPath);
  if (!hasLegacy && !hasJson) return { migrated: false };
  try {
    const r = await loadConfig({ home, defaultWorkdir: process.cwd() });
    if (r.migration?.migrated) {
      io.out(`Migrated v0.x config -> ${r.path}\n`);
      if (r.migration.warnings.length > 0) {
        for (const w of r.migration.warnings) io.out(`  warn: ${w}\n`);
      }
      return { migrated: true };
    }
  } catch (err) {
    io.out(`Warning: migration check failed: ${(err as Error).message}\n`);
  }
  return { migrated: false };
}

async function loadCurrent(home: string): Promise<TliveConfigV1> {
  try {
    const r = await loadConfig({ home, defaultWorkdir: process.cwd(), noWrite: true });
    return r.config;
  } catch {
    return { version: '1', daemon: {}, workspaces: [] };
  }
}

async function gatherWorkspace(io: Io, cwd: string, current: TliveConfigV1): Promise<WorkspaceConfigEntry> {
  const git = await detectGitContext(cwd);
  io.out('\nWorkspace detection:\n');
  io.out(`  cwd:        ${cwd}\n`);
  io.out(`  git:        ${git.gitRemote ?? '(none)'}\n`);
  io.out(`  branch:     ${git.headBranch ?? '(unknown)'}\n`);
  io.out(`  suggested:  ${git.suggestedName}\n\n`);

  const name = io.tty
    ? await askWithDefault(io, 'Workspace name', git.suggestedName)
    : git.suggestedName;
  const workdir = io.tty
    ? await askWithDefault(io, 'Working directory', cwd)
    : cwd;

  const existing = current.workspaces.find((w) => w.workdir === workdir || w.name === name);
  if (existing && io.tty) {
    io.out(`A workspace named "${existing.name}" already exists at ${existing.workdir}. Re-using its id.\n`);
  }

  return {
    id: existing?.id ?? nowId('ws'),
    name: name || git.suggestedName,
    workdir: workdir || cwd,
    gitRemote: git.gitRemote,
    defaults: existing?.defaults ?? { provider: 'claude' },
    budget: existing?.budget,
  };
}

async function gatherPlatform(
  io: Io,
  kind: 'telegram' | 'feishu',
  current: TliveConfigV1['channels'] | undefined,
  workspace: WorkspaceConfigEntry | undefined,
): Promise<TliveConfigV1['channels']> {
  const next: TliveConfigV1['channels'] = { ...(current ?? {}) };
  if (!io.tty) return next;
  switch (kind) {
    case 'telegram': {
      const token = await askWithDefault(io, '  Telegram bot token', current?.telegram?.token);
      if (!token) break;
      const chatId = await askWithDefault(io, '  Default chat id (your DM with the bot, or a group id)', current?.telegram?.chatId);
      next.telegram = { token, chatId: chatId || undefined };
      break;
    }
    case 'feishu': {
      const appId = await askWithDefault(io, '  Feishu app_id', current?.feishu?.appId);
      const appSecret = await askWithDefault(io, '  Feishu app_secret', current?.feishu?.appSecret);
      if (appId && appSecret) next.feishu = { appId, appSecret };
      break;
    }
  }
  return next;
}

async function writeConfig(home: string, config: TliveConfigV1): Promise<string> {
  await fs.mkdir(home, { recursive: true });
  const path = join(home, 'config.json');
  const tmp = path + '.tmp';
  const parsed = parseConfig(config);
  if (!parsed.ok) {
    throw new Error(`refusing to write invalid config:\n  ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('\n  ')}`);
  }
  await fs.writeFile(tmp, JSON.stringify(parsed.value, null, 2), 'utf8');
  await fs.rename(tmp, path);
  return path;
}

function upsertWorkspace(config: TliveConfigV1, ws: WorkspaceConfigEntry): TliveConfigV1 {
  const i = config.workspaces.findIndex((w) => w.id === ws.id || w.workdir === ws.workdir);
  const workspaces = [...config.workspaces];
  if (i >= 0) workspaces[i] = { ...workspaces[i], ...ws };
  else workspaces.push(ws);
  return { ...config, workspaces };
}

async function dispatchInstallIntegrations(io: Io): Promise<void> {
  // Prefer the sibling dist/ entry so build artifacts stay in sync.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'tlive-install-integrations.mjs'),
    join(here, '..', '..', 'dist', 'src', 'tlive-install-integrations.mjs'),
    join(here, '..', '..', '..', 'dist', 'src', 'tlive-install-integrations.mjs'),
  ];
  const entry = candidates.find(existsSync);
  if (!entry) {
    io.out('(install-integrations entry not built yet; skip)\n');
    return;
  }
  const r = spawnSync(process.execPath, [entry, 'all'], { stdio: 'inherit' });
  if (r.status !== 0) {
    io.out(`install-integrations exited with ${r.status}\n`);
  }
}

export async function setupCommand(argv: string[] = []): Promise<void> {
  const io = makeIo();
  try {
    const home = join(homedir(), '.tlive');
    io.out('tlive setup — wizard (v1.0)\n');
    io.out(`Config home: ${home}\n\n`);

    await runMigrationIfNeeded(io, home);
    let config = await loadCurrent(home);

    // Workspace step.
    const ws = await gatherWorkspace(io, process.cwd(), config);
    config = upsertWorkspace(config, ws);

    // Platform step.
    if (io.tty) {
      io.out('\nIM platforms (press enter to skip each):\n');
      const pickPlatform = argv.find((a) => a.startsWith('--platform='))?.split('=')[1];
      const order: Array<'telegram' | 'feishu'> = pickPlatform
        ? [pickPlatform as 'telegram' | 'feishu']
        : ['telegram', 'feishu'];
      const wsBeingConfigured = config.workspaces.find((w) => w.id === ws.id) ?? ws;
      for (const p of order) {
        io.out(`\n${p}:\n`);
        config.channels = await gatherPlatform(io, p, config.channels, wsBeingConfigured);
      }
      config = upsertWorkspace(config, wsBeingConfigured);
    } else {
      io.out('\n(non-interactive stdin — platform credentials left unchanged)\n');
    }

    const path = await writeConfig(home, config);
    io.out(`\nWrote ${path}\n`);
    io.out('\nNext steps:\n');
    io.out('  tlive start                   # launch the daemon\n');
    io.out('  tlive doctor                  # sanity check\n');
    io.out('  tlive install-integrations    # wire Claude + Codex skills\n');

    if (io.tty) {
      const run = await askWithDefault(io, '\nRun `tlive install-integrations all` now?', 'Y/n');
      if (/^(y|yes|)$/i.test(run.trim())) {
        await dispatchInstallIntegrations(io);
      }
    }
  } finally {
    io.close();
  }
}

if (process.argv[1]?.endsWith('tlive-setup.mjs')) {
  setupCommand(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`tlive setup failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
