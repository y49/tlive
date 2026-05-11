// src/cli/subcommands/handoff.ts
//
// Scan ~/.claude/projects/<encoded cwd>/*.jsonl for the most recent session,
// then IPC the daemon to take ownership.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from '../../kernel/ipc/client.js';

function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export async function runHandoff(argv: string[]): Promise<void> {
  const explicit = argv.find((a) => !a.startsWith('-'));
  let sdkSessionId = explicit;
  if (!sdkSessionId) {
    const cwd = process.cwd();
    const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      if (files.length === 0) { process.stderr.write(`tlive handoff: no sessions found in ${dir}\n`); process.exit(1); }
      const newest = files.map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
      sdkSessionId = newest.f.replace(/\.jsonl$/, '');
    } catch (e) {
      process.stderr.write(`tlive handoff: cannot scan ${dir}: ${(e as Error).message}\n`); process.exit(1);
    }
  }
  const r = await request({ kind: 'handoff.register', sdkSessionId: sdkSessionId!, cwd: process.cwd() });
  if (r.kind === 'handoff.registered') {
    process.stdout.write(`tlive handoff: session ${sdkSessionId!.slice(0, 8)} now daemon-driven (tlive id: ${r.tliveSessionId.slice(0, 8)})\nCtrl-C the terminal claude when ready.\n`);
  } else {
    process.stderr.write(`tlive handoff: error: ${(r as { message?: string }).message ?? 'unknown'}\n`); process.exit(1);
  }
}
