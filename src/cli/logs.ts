// src/cli/logs.ts — `tlive logs [--follow] <alias>`
//
// Streams a session's jsonl history via the daemon's `session.logs` IPC
// request. Writes one line per event frame to stdout and exits cleanly on
// `logs.end`. `--follow` keeps the stream open (daemon caps at ~10 min).

import { stream, ensureDaemonRunning } from '../ipc/client.js';

export async function logsCommand(alias: string | undefined, opts: { follow?: boolean } = {}): Promise<void> {
  if (!alias) {
    process.stderr.write('usage: tlive logs [--follow] <session-alias>\n');
    process.exit(2);
  }
  await ensureDaemonRunning();

  for await (const frame of stream({ kind: 'session.logs', alias, follow: opts.follow === true })) {
    if (frame.kind === 'logs.line') {
      process.stdout.write(`${frame.line}\n`);
    } else if (frame.kind === 'logs.end') {
      return;
    } else if (frame.kind === 'error') {
      process.stderr.write(`error: ${frame.message}\n`);
      process.exit(1);
    }
  }
}

if (process.argv[1]?.endsWith('tlive-logs.mjs')) {
  const args = process.argv.slice(2);
  const follow = args.includes('--follow') || args.includes('-f');
  const id = args.filter((a) => !a.startsWith('-'))[0];
  await logsCommand(id, { follow });
}
