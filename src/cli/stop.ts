// src/cli/stop.ts — `tlive stop <alias>`
//
// Stops a session by short-alias prefix or full sdkSessionId via the
// daemon's v1 IPC `session.stop` request. Idempotent — targeting a session
// that's already stopped returns `error` with a clear message.

import { request, ensureDaemonRunning } from '../ipc/client.js';

export async function stopCommand(alias: string | undefined): Promise<void> {
  if (!alias) {
    process.stderr.write('usage: tlive stop <session-alias>\n');
    process.exit(2);
  }
  await ensureDaemonRunning();
  const resp = await request({ kind: 'session.stop', alias });
  if (resp.kind === 'session.stopped') {
    process.stdout.write(`stopped ${resp.sdkSessionId}\n`);
    return;
  }
  if (resp.kind === 'error') {
    process.stderr.write(`error: ${resp.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`error: unexpected response ${resp.kind}\n`);
  process.exit(1);
}

if (process.argv[1]?.endsWith('tlive-stop.mjs')) { await stopCommand(process.argv[2]); }
