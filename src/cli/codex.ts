// src/cli/codex.ts
//
// `tlive codex [prompt] [--workdir D]` — thin launcher.
// Starts daemon if needed, asks it to create a codex session, prints id, exits.

import { ensureDaemonRunning, sendRequest } from './ipc-client-lite.js';

export interface CodexCommandOptions {
  prompt?: string;
  workdir?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export async function codexCommand(opts: CodexCommandOptions = {}): Promise<void> {
  await ensureDaemonRunning();
  const resp = await sendRequest({
    type: 'create_session',
    payload: {
      provider: 'codex',
      workdir: opts.workdir ?? process.cwd(),
      initialPrompt: opts.prompt,
      effort: opts.effort,
    },
  });
  if (resp.type === 'session_created') {
    process.stdout.write(`session ${resp.payload.sessionId} started\n`);
    process.stdout.write(`→ continue in your IM client (Telegram/Discord/Feishu)\n`);
  } else if (resp.type === 'error') {
    process.stderr.write(`error: ${resp.payload.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('tlive-codex.mjs')) {
  const args = process.argv.slice(2);
  const opts: CodexCommandOptions = {};
  while (args.length) {
    const a = args.shift()!;
    if (a === '--workdir') opts.workdir = args.shift();
    else if (a === '--effort') opts.effort = args.shift() as 'low' | 'medium' | 'high' | 'max';
    else if (!opts.prompt) opts.prompt = a;
  }
  await codexCommand(opts);
}
