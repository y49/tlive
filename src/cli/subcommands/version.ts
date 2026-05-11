// src/cli/subcommands/version.ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runVersion(_argv: string[]): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // dist/src/tlive-cli.mjs → ../../package.json
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    process.stdout.write(`${pkg.version ?? 'unknown'}\n`);
  } catch {
    process.stdout.write('unknown\n');
  }
}
