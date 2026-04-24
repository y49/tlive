// src/cli/version.ts — `tlive version`
//
// Prints the installed tlive version and the active Node runtime. An optional
// network probe (`npm view tlive version`) surfaces an "update available" hint
// when online; failure is swallowed so the command stays fast / offline-safe.
//
// Spec §12 lists this as a terminal command dispatched by scripts/cli.js.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function getInstalledVersion(): string {
  try {
    // dist/src/tlive-version.mjs → dist/src → dist → package root
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', '..', 'package.json'),
      join(here, '..', '..', '..', 'package.json'),
      join(here, '..', '..', '..', '..', 'package.json'),
    ];
    for (const p of candidates) {
      try {
        const text = readFileSync(p, 'utf8');
        const pkg = JSON.parse(text) as { name?: string; version?: string };
        if (pkg.name === 'tlive' && typeof pkg.version === 'string') return pkg.version;
      } catch { /* try next */ }
    }
  } catch { /* fall through */ }
  return 'unknown';
}

function probeLatest(): string | null {
  try {
    const out = execSync('npm view tlive version', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function versionCommand(): void {
  const ver = getInstalledVersion();
  process.stdout.write(`tlive          ${ver}\n`);
  process.stdout.write(`node           ${process.version}\n`);

  const latest = probeLatest();
  if (!latest) {
    // Online check failed or skipped — stay quiet.
    return;
  }
  if (latest === ver) {
    process.stdout.write('\nUp to date.\n');
  } else {
    process.stdout.write(`\nUpdate available: ${ver} -> ${latest}\n`);
    process.stdout.write("Run: tlive update\n");
  }
}

if (process.argv[1]?.endsWith('tlive-version.mjs')) {
  versionCommand();
}
