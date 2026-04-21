// src/cli/claude.ts
//
// `tlive claude [prompt] [--workdir D]` — thin launcher.
// Starts daemon if needed, asks it to create a claude session, prints id, exits.

import { ensureDaemonRunning, sendRequest } from './ipc-client-lite.js';

export interface ClaudeCommandOptions {
  prompt?: string;
  workdir?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export async function claudeCommand(opts: ClaudeCommandOptions = {}): Promise<void> {
  await ensureDaemonRunning();
  const resp = await sendRequest({
    type: 'create_session',
    payload: {
      provider: 'claude',
      workdir: opts.workdir ?? process.cwd(),
      initialPrompt: opts.prompt,
      model: opts.model,
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

// entry-point wrapper — parse argv flags (positional prompt, --workdir, --model, --effort)
if (process.argv[1]?.endsWith('tlive-claude.mjs')) {
  const args = process.argv.slice(2);
  const opts: ClaudeCommandOptions = {};
  while (args.length) {
    const a = args.shift()!;
    if (a === '--workdir') opts.workdir = args.shift();
    else if (a === '--model') opts.model = args.shift();
    else if (a === '--effort') opts.effort = args.shift() as 'low' | 'medium' | 'high' | 'max';
    else if (!opts.prompt) opts.prompt = a;
  }
  await claudeCommand(opts);
}
