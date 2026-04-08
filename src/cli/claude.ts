// src/cli/claude.ts
import { stdin, stdout, exit } from 'node:process';
import { TLiveLoop } from '../loop.js';
import { ClaudeAdapter } from '../sdk/claudeAdapter.js';
import { loadConfig } from '../config.js';

export interface ClaudeCommandOptions {
  resume?: boolean;
  sessionId?: string;
  web?: boolean;
  workdir?: string;
}

export async function claudeCommand(opts: ClaudeCommandOptions = {}): Promise<void> {
  const config = loadConfig();
  const adapter = new ClaudeAdapter();
  const workdir = opts.workdir ?? process.cwd();

  const loop = new TLiveLoop({ workdir, adapter, config, sessionId: opts.sessionId });

  // Raw mode for terminal passthrough
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
  }

  // Forward PTY output to terminal
  loop.on('ptyData', (data: string) => stdout.write(data));

  // Handle terminal input
  stdin.on('data', (data: Buffer) => {
    loop.handleTerminalInput(data.toString());
  });

  // Graceful shutdown
  const cleanup = async () => {
    await loop.stop();
    if (stdin.isTTY) stdin.setRawMode(false);
    exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Show session info
  const info = loop.sessionInfo;
  console.error(`[tlive] Session: ${info.sessionId.slice(0, 8)}... | ${workdir}`);
  console.error(`[tlive] IM notifications active. Press Ctrl+C to exit.`);

  try {
    await loop.start();
    // Keep running until session ends
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (loop.sessionState === 'idle') { clearInterval(check); resolve(); }
      }, 500);
    });
  } finally {
    await cleanup();
  }
}
