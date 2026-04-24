// src/cli/list.ts — `tlive list`
//
// Talks to the daemon via the v1 IPC protocol (`session.list`). Auto-starts
// the daemon when absent so a fresh shell can `tlive list` without friction.

import { request, ensureDaemonRunning } from '../ipc/client.js';

export async function listCommand(): Promise<void> {
  await ensureDaemonRunning();
  const resp = await request({ kind: 'session.list' });
  if (resp.kind === 'error') {
    process.stderr.write(`error: ${resp.message}\n`);
    process.exit(1);
  }
  if (resp.kind !== 'session.list') {
    process.stderr.write(`error: unexpected response ${resp.kind}\n`);
    process.exit(1);
  }
  if (resp.sessions.length === 0) {
    process.stdout.write('(no sessions)\n');
    return;
  }
  process.stdout.write('ID        PROVIDER  WORKDIR                         STATUS   COST\n');
  for (const s of resp.sessions) {
    const cost = `$${s.costUsd.toFixed(4)}`;
    process.stdout.write(
      `${s.shortAlias.padEnd(9)} ${s.provider.padEnd(9)} ${s.workdir.padEnd(32).slice(0, 32)} ${s.status.padEnd(8)} ${cost}\n`,
    );
  }
}

if (process.argv[1]?.endsWith('tlive-list.mjs')) { await listCommand(); }
