#!/usr/bin/env node
// scripts/build.mjs
//
// Unified build for tlive. Emits exactly 2 entries:
//   - dist/src/tlive-daemon.mjs (long-running daemon, src/kernel/daemon/main.ts)
//   - dist/src/tlive-cli.mjs    (CLI dispatcher, src/cli/main.ts; lazy-imports subcommands)

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const EXTERNAL = [
  'node-pty',
  'ws',
  'grammy',
  '@grammyjs/runner',
  '@grammyjs/transformer-throttler',
  '@larksuiteoapi/node-sdk',
  'https-proxy-agent',
  'socks-proxy-agent',
];

async function buildEntry(entryRel, outBaseName) {
  const entry = join(ROOT, entryRel);
  if (!existsSync(entry)) return false;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: join(ROOT, 'dist', 'src', `${outBaseName}.mjs`),
    external: EXTERNAL,
    logLevel: 'warning',
  });
  return true;
}

const daemonOk = await buildEntry('src/kernel/daemon/main.ts', 'tlive-daemon');
if (daemonOk) console.log('built dist/src/tlive-daemon.mjs');

const cliOk = await buildEntry('src/cli/main.ts', 'tlive-cli');
if (cliOk) console.log('built dist/src/tlive-cli.mjs');
