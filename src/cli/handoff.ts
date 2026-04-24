// src/cli/handoff.ts — `tlive handoff <alias>`
//
// Release a daemon-owned session so a local `claude --resume <sdkId>` (or
// codex equivalent) can pick it up from the terminal. Thin IPC wrapper —
// cross-platform (no shell scripts).

import { request, ensureDaemonRunning } from '../ipc/client.js';

export async function handoffCommand(alias: string | undefined): Promise<void> {
  if (!alias) {
    process.stderr.write('usage: tlive handoff <session-alias>\n');
    process.exit(2);
  }
  await ensureDaemonRunning();
  const resp = await request({ kind: 'handoff.release', alias });
  if (resp.kind === 'handoff.released') {
    process.stdout.write(
      `released ${resp.sdkId}\n` +
      `continue locally with: claude --resume ${resp.sdkId}\n` +
      `(or: codex --resume ${resp.sdkId})\n`,
    );
    return;
  }
  if (resp.kind === 'error') {
    process.stderr.write(`error: ${resp.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`error: unexpected response ${resp.kind}\n`);
  process.exit(1);
}

if (process.argv[1]?.endsWith('tlive-handoff.mjs')) { await handoffCommand(process.argv[2]); }
