// src/cli/takeback.ts — `tlive takeback <sdkSessionId>`
//
// Daemon re-adopts an sdkSessionId (e.g. one the user was driving locally
// via `claude --resume`) into a LocalSession. The operator should exit
// the local claude/codex session FIRST so there's no jsonl writer contention.

import { request, ensureDaemonRunning } from '../ipc/client.js';

export async function takebackCommand(sdkId: string | undefined): Promise<void> {
  if (!sdkId) {
    process.stderr.write(
      'usage: tlive takeback <sdkSessionId>\n' +
      'Exit your local `claude --resume` / `codex --resume` first.\n',
    );
    process.exit(2);
  }
  await ensureDaemonRunning();
  const resp = await request({ kind: 'handoff.take', sdkId });
  if (resp.kind === 'handoff.taken') {
    process.stdout.write(
      `taken ${resp.sdkId}\n` +
      `the daemon now owns this session; continue in IM.\n`,
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

if (process.argv[1]?.endsWith('tlive-takeback.mjs')) { await takebackCommand(process.argv[2]); }
