// src/cli/claude.ts
import { stdin, stdout, exit } from 'node:process';
import { networkInterfaces } from 'node:os';
import { TLiveLoop } from '../loop.js';
import { ClaudeAdapter } from '../sdk/claudeAdapter.js';
import { WebTerminal } from '../core/webTerminal.js';
import { loadConfig } from '../config.js';

export interface ClaudeCommandOptions {
  resume?: boolean;
  sessionId?: string;
  web?: boolean;
  workdir?: string;
}

function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

export async function claudeCommand(opts: ClaudeCommandOptions = {}): Promise<void> {
  const config = loadConfig();
  const adapter = new ClaudeAdapter();
  const workdir = opts.workdir ?? process.cwd();

  const loop = new TLiveLoop({ workdir, adapter, config, sessionId: opts.sessionId });

  // Start WebTerminal
  const webPort = config.port;
  const webToken = config.token || loop.sessionInfo.sessionId.slice(0, 16);
  const web = new WebTerminal({ port: webPort, token: webToken });

  // Wire WebTerminal ↔ PTY
  loop.on('ptyData', (data: string) => {
    stdout.write(data);
    web.broadcast(data);
  });

  web.setInputHandler((data) => loop.handleTerminalInput(data));
  web.setResizeHandler((cols, rows) => {
    // Only resize if input comes from web (don't fight terminal resize)
  });

  await web.startOnPort(webPort);

  const localIP = getLocalIP();
  const url = `http://${localIP}:${webPort}/?token=${webToken}`;

  // Raw mode for terminal passthrough
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
  }

  // Handle terminal input
  stdin.on('data', (data: Buffer) => {
    loop.handleTerminalInput(data.toString());
  });

  // Graceful shutdown
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    web.stop();
    await loop.stop();
    if (stdin.isTTY) stdin.setRawMode(false);
    exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Show session info
  const info = loop.sessionInfo;
  console.error('');
  console.error(`  \x1b[36m⚡ TLive v1.0\x1b[0m`);
  console.error(`  Session:  ${info.sessionId.slice(0, 8)}...`);
  console.error(`  Workdir:  ${workdir}`);
  console.error(`  Terminal: \x1b[4m${url}\x1b[0m`);
  console.error('');

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
