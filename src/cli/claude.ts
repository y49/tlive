// src/cli/claude.ts
import { stdin, stdout, exit } from 'node:process';
import { networkInterfaces } from 'node:os';
import { TLiveLoop } from '../loop.js';
import { ClaudeAdapter } from '../sdk/claudeAdapter.js';
import { WebTerminal } from '../core/webTerminal.js';
import { IPCClient } from '../ipc.js';
import { loadConfig } from '../config.js';
import { findLastSession } from '../core/sessionDiscovery.js';
import { createWorktree } from '../core/worktreeManager.js';

export interface ClaudeCommandOptions {
  resume?: boolean;
  sessionId?: string;
  web?: boolean;
  workdir?: string;
  worktree?: boolean | string;
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

export function setupQR(port: number, token: string): void {
  const localIP = getLocalIP();
  const url = `http://${localIP}:${port}/?token=${token}`;

  console.log('');
  console.log('  \x1b[36m⚡ TLive Web Terminal\x1b[0m');
  console.log('');
  console.log(`  URL: \x1b[4m${url}\x1b[0m`);
  console.log(`  Pair: \x1b[4mhttp://${localIP}:${port}/pair?token=${token}\x1b[0m`);
  console.log('');
  console.log('  Open this URL on your phone or another device.');
  console.log('  For Telegram pairing, send this to your bot:');
  console.log(`  /start pair_${token.slice(0, 16)}`);
  console.log('');
}

export async function claudeCommand(opts: ClaudeCommandOptions = {}): Promise<void> {
  const config = loadConfig();
  const adapter = new ClaudeAdapter();
  let workdir = opts.workdir ?? process.cwd();

  // Create isolated worktree if requested
  if (opts.worktree) {
    try {
      const name = typeof opts.worktree === 'string' ? opts.worktree : undefined;
      const wt = createWorktree(workdir, name);
      console.error(`  Worktree: ${wt.path} (${wt.branch})`);
      workdir = wt.path;
    } catch (err) {
      console.error(`  Worktree: \x1b[31mfailed\x1b[0m — ${(err as Error).message}`);
    }
  }

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
  try {
    await web.startOnPort(webPort);
  } catch (err) {
    console.error(`  \x1b[31mWeb terminal failed:\x1b[0m ${(err as Error).message}`);
    console.error(`  Continuing without web terminal.`);
  }

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

    // Text replies to terminal notifications → write to PTY as user input
    ipc.on('terminal_input', (payload: Record<string, unknown>) => {
      const text = payload.text as string;
      if (text) loop.handleTerminalInput(text + '\n');
    });

    // Config updates from IM (effort/model changes) → display + store for next SDK handoff
    ipc.on('config_update', (payload: Record<string, unknown>) => {
      if (payload.effort) console.error(`  Effort:   ${payload.effort}`);
      if (payload.model) console.error(`  Model:    ${payload.model}`);
      // Store for next SDK handoff
    });

    // Question answers from IM → write answer to PTY as user input
    ipc.on('question_answer', (payload: Record<string, unknown>) => {
      const answer = payload.answer as string;
      if (answer !== undefined) {
        loop.handleTerminalInput(answer + '\n');
      }
    });

    ipc.on('reconnected', () => {
      console.error(`  IM:       \x1b[32mreconnected\x1b[0m`);
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
