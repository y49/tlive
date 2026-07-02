#!/usr/bin/env node
// scripts/build.mjs
//
// Unified build for tlive. Emits exactly 2 entries:
//   - dist/src/tlive-daemon.mjs (long-running daemon, src/kernel/daemon/main.ts)
//   - dist/src/tlive-cli.mjs    (CLI dispatcher, src/cli/main.ts; lazy-imports subcommands)

import { build } from 'esbuild';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
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

// Frontend bundle (browser) — xterm terminal page → dist/web
mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true });
const feEntry = join(ROOT, 'web', 'src', 'terminal.ts');
if (existsSync(feEntry)) {
  await build({
    entryPoints: [feEntry],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2020'],
    outfile: join(ROOT, 'dist', 'web', 'terminal.js'),
    loader: { '.css': 'css' },
    minify: true,
    logLevel: 'warning',
  });
  copyFileSync(join(ROOT, 'web', 'terminal.html'), join(ROOT, 'dist', 'web', 'terminal.html'));
  console.log('built dist/web/terminal.js + terminal.html');
}

// Frontend bundle (browser) — dashboard page → dist/web
const dashEntry = join(ROOT, 'web', 'src', 'dashboard.ts');
if (existsSync(dashEntry)) {
  await build({
    entryPoints: [dashEntry],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2020'],
    outfile: join(ROOT, 'dist', 'web', 'dashboard.js'),
    minify: true,
    logLevel: 'warning',
  });
  copyFileSync(join(ROOT, 'web', 'dashboard.html'), join(ROOT, 'dist', 'web', 'dashboard.html'));
  console.log('built dist/web/dashboard.js + dashboard.html');
}
