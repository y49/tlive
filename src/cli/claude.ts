// src/cli/claude.ts
import { stdin, stdout, exit } from 'node:process';
import { networkInterfaces } from 'node:os';
import { TLiveLoop } from '../loop.js';
import { ClaudeAdapter } from '../sdk/claudeAdapter.js';
import { WebTerminal } from '../core/webTerminal.js';
import { IPCClient } from '../ipc.js';
import { loadConfig } from '../config.js';
import { findLastSession } from '../core/sessionDiscovery.js';

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

  // Resolve session ID: explicit > resume last > new
  let sessionId = opts.sessionId;
  if (!sessionId && opts.resume) {
    sessionId = findLastSession(workdir) ?? undefined;
    if (sessionId) {
      console.error(`  Resuming session ${sessionId.slice(0, 8)}...`);
    }
  }

  const loop = new TLiveLoop({ workdir, adapter, config, sessionId });

  // Start WebTerminal
  const webPort = config.port;
  const webToken = config.token || loop.sessionInfo.sessionId.slice(0, 16);
  const web = new WebTerminal({ port: webPort, token: webToken });

  loop.on('ptyData', (data: string) => {
    stdout.write(data);
    web.broadcast(data);
  });
  web.setInputHandler((data) => loop.handleTerminalInput(data));
  await web.startOnPort(webPort);

  const localIP = getLocalIP();
  const url = `http://${localIP}:${webPort}/?token=${webToken}`;

  // Connect to bridge IPC (auto-retries while bridge starts up)
  const ipc = new IPCClient();
  const ipcConnected = await ipc.connect();

  if (ipcConnected) {
    // Wire IPC as the IM transport
    loop.setIMTarget('ipc', async (_chatId, text, buttons) => {
      ipc.send('notification', {
        text,
        buttons,
        sessionId: loop.sessionInfo.sessionId,
        workdir,
      });
      // Wait for bridge to confirm message was sent (with messageId)
      return new Promise<string | undefined>((resolve) => {
        const timeout = setTimeout(() => resolve(undefined), 3000);
        const handler = (payload: Record<string, unknown>) => {
          clearTimeout(timeout);
          ipc.removeListener('message_sent', handler);
          resolve(payload.messageId as string | undefined);
        };
        ipc.on('message_sent', handler);
      });
    });

    // Permission actions from IM → loop
    ipc.on('permission_action', (payload: Record<string, unknown>) => {
      loop.handleIMAction(
        payload.action as string,
        payload.toolUseId as string,
      );
    });

    console.error(`  IM:       \x1b[32mconnected\x1b[0m (bridge IPC)`);
  } else {
    console.error(`  IM:       \x1b[33mnot connected\x1b[0m (bridge not running)`);
  }

  // Raw mode for terminal passthrough
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
  }
  stdin.on('data', (data: Buffer) => loop.handleTerminalInput(data.toString()));

  // Graceful shutdown
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    ipc.disconnect();
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

  try {
    await loop.start();
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (loop.sessionState === 'idle') { clearInterval(check); resolve(); }
      }, 500);
    });
  } finally {
    await cleanup();
  }
}
