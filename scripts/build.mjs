#!/usr/bin/env node
// scripts/build.mjs
//
// Unified build for tlive. Produces ESM bundles under dist/src/ for:
//   - daemon entry (src/daemon/main.ts → dist/src/tlive-daemon.mjs) — when present (T9+)
//   - CLI entries (src/cli/*.ts → dist/src/tlive-<name>.mjs)
//
// CLI files that are merely shared helpers (e.g. ipc-client-lite) are not
// built as standalone entries. Only files that are user-facing subcommands
// are emitted here.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const EXTERNAL = [
  'node-pty',
  'ws',
  '@anthropic-ai/claude-agent-sdk',
  '@modelcontextprotocol/sdk',
  'grammy',
  '@grammyjs/runner',
  '@grammyjs/transformer-throttler',
  'discord.js',
  '@larksuiteoapi/node-sdk',
  'https-proxy-agent',
  'socks-proxy-agent',
];

/** Build a single entry. `outfile` is relative to dist/src/. */
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

// Daemon entry (present from T9 onwards)
const daemonOk = await buildEntry('src/daemon/main.ts', 'tlive-daemon');
if (daemonOk) console.log('built dist/src/tlive-daemon.mjs');

// CLI entries — each is a user-facing subcommand dispatched by scripts/cli.js
const cliEntries = [
  // Daemon lifecycle
  'start',
  'stop',
  'restart',
  'status',
  'doctor',
  'daemon-logs',
  // Handoff
  'handoff',
  'takeback',
  // MCP subsystem
  'mcp',
  // Wizards / meta
  'setup',
  'install-integrations',
  'version',
  'update',
];

for (const name of cliEntries) {
  const ok = await buildEntry(`src/cli/${name}.ts`, `tlive-${name}`);
  if (ok) console.log(`built dist/src/tlive-${name}.mjs`);
}
