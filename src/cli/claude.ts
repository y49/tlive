// src/cli/claude.ts
import { stdin, stdout, exit } from 'node:process';
import { networkInterfaces, homedir } from 'node:os';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { TLiveLoop } from '../loop.js';
import { ClaudeAdapter } from '../sdk/claudeAdapter.js';
import { WebTerminal } from '../core/webTerminal.js';
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

const IPC_PATH = join(homedir(), '.tlive', 'ipc.sock');

/**
 * Connect to bridge's IPC socket. Returns null if bridge is not running.
 */
function connectIPC(): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(IPC_PATH, () => resolve(socket));
    socket.on('error', () => resolve(null));
  });
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

  // Wire WebTerminal ↔ PTY
  loop.on('ptyData', (data: string) => {
    stdout.write(data);
    web.broadcast(data);
  });

  web.setInputHandler((data) => loop.handleTerminalInput(data));

  await web.startOnPort(webPort);

  const localIP = getLocalIP();
  const url = `http://${localIP}:${webPort}/?token=${webToken}`;

  // Connect to bridge IPC for IM notifications
  const ipc = await connectIPC();
  if (ipc) {
    // Set up IPC-based IM sending
    loop.setIMTarget('ipc', async (_chatId: string, text: string, buttons?) => {
      const msg = JSON.stringify({
        type: 'notification',
        payload: {
          text,
          buttons,
          sessionId: loop.sessionInfo.sessionId,
          workdir,
        },
      }) + '\n';
      ipc.write(msg);
      // Wait for message_sent response (with messageId)
      return new Promise<string | undefined>((resolve) => {
        const timeout = setTimeout(() => resolve(undefined), 3000);
        const onData = (raw: Buffer) => {
          const lines = raw.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const resp = JSON.parse(line);
              if (resp.type === 'message_sent') {
                clearTimeout(timeout);
                ipc.removeListener('data', onData);
                resolve(resp.payload.messageId);
                return;
              }
              if (resp.type === 'permission_action') {
                // Handle permission action from IM user
                const { action, toolUseId } = resp.payload;
                loop.handleIMAction(action, toolUseId);
              }
            } catch { /* skip */ }
          }
        };
        ipc.on('data', onData);
      });
    });

    // Also listen for incoming IPC messages (permission actions)
    let ipcBuffer = '';
    ipc.on('data', (raw) => {
      ipcBuffer += raw.toString();
      const lines = ipcBuffer.split('\n');
      ipcBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'permission_action') {
            const { action, toolUseId } = msg.payload;
            loop.handleIMAction(action, toolUseId);
          }
        } catch { /* skip */ }
      }
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

  // Handle terminal input
  stdin.on('data', (data: Buffer) => {
    loop.handleTerminalInput(data.toString());
  });

  // Graceful shutdown
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    ipc?.destroy();
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
