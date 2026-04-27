// src/cli/update.ts — `tlive update`
//
// Runs `npm install -g tlive@latest` and prints a friendly result. When the
// daemon is running locally we do NOT restart it automatically — the user
// controls that with `tlive stop && tlive start` because in-flight sessions
// might be mid-turn. A pointer is printed instead.
//
// This is intentionally a tiny wrapper. Operators who prefer `npm`, `pnpm`,
// or `yarn` global installs can invoke them directly; we just provide a
// consistent `tlive update` entry point.

import { spawnSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getInstalledVersion } from './version.js';

export function updateCommand(args: string[] = []): void {
  const current = getInstalledVersion();
  process.stdout.write(`Current version: ${current}\n`);

  // Allow `tlive update --dry-run` to stop before mutating anything. Useful
  // for docs / CI checks.
  if (args.includes('--dry-run')) {
    process.stdout.write('Would run: npm install -g tlive@latest\n');
    return;
  }

  process.stdout.write('Running: npm install -g tlive@latest\n');
  const r = spawnSync('npm', ['install', '-g', 'tlive@latest'], { stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write('Update failed.\n');
    process.stderr.write('Tip: run as root or via your Node version manager (nvm/fnm/asdf).\n');
    process.exit(r.status ?? 1);
  }

  try {
    const updated = execSync('npm view tlive version', { encoding: 'utf-8', timeout: 5000 }).trim();
    process.stdout.write(`\nUpdated to ${updated || 'latest'}.\n`);
  } catch {
    process.stdout.write('\nUpdated. (npm view skipped — offline?)\n');
  }

  const pidFile = join(homedir(), '.tlive', 'daemon.pid');
  if (existsSync(pidFile)) {
    process.stdout.write([
      '',
      'The tlive daemon is currently running. To pick up the new version:',
      '  tlive stop && tlive start',
      'In-flight sessions are preserved across restarts via jsonl auto-resume.',
      '',
    ].join('\n'));
  }
}

if (process.argv[1]?.endsWith('tlive-update.mjs')) {
  updateCommand(process.argv.slice(2));
}
