// src/cli/runFlavor.ts
// Shared flavor runner — parameterized by ProviderAdapter and scanner factory.
// `tlive claude` and `tlive codex` both delegate here.

import { stdin, stdout, exit } from 'node:process';
import { networkInterfaces } from 'node:os';
import { TLiveLoop } from '../loop.js';
import { IPCClient } from '../ipc.js';
import { loadConfig } from '../config.js';
import { createWorktree } from '../core/worktreeManager.js';
import type { ProviderAdapter } from '../sdk/providerAdapter.js';
import type { ScannerFactory } from '../core/sessionManager.js';

export interface RunFlavorOptions {
  adapter: ProviderAdapter;
  runtimeLabel: 'Claude' | 'Codex';
  scannerFactory: ScannerFactory;
  sessionId?: string;
  resume?: boolean;
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

export async function runFlavor(opts: RunFlavorOptions): Promise<void> {
  const config = loadConfig();
  const { adapter, runtimeLabel, scannerFactory } = opts;
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

  // Resolve session ID: explicit > resume last (adapter-opt-in) > new
  // Providers that let us choose the session id (Claude) implement
  // `findLastSession`; providers that assign their own id (Codex) leave it
  // unset and rely on the scanner's mtime discovery.
  let sessionId = opts.sessionId;
  if (!sessionId && opts.resume) {
    sessionId = adapter.findLastSession?.(workdir) ?? undefined;
    if (sessionId) {
      console.error(`  Resuming session ${sessionId.slice(0, 8)}...`);
    }
  }

  const loop = new TLiveLoop({ workdir, adapter, config, sessionId, scannerFactory });

  // Connect to bridge IPC (auto-retries while bridge starts up)
  const ipc = new IPCClient();
  const ipcConnected = await ipc.connect();

  // Register session with bridge (for web terminal + IM routing)
  if (ipcConnected) {
    ipc.send('session_register', {
      sessionId: loop.sessionInfo.sessionId,
      workdir,
      projectName: workdir.split('/').filter(Boolean).pop() ?? 'unknown',
    });
  }

  // PTY output → local terminal + IPC (for bridge web terminal)
  loop.on('ptyData', (data: string) => {
    stdout.write(data);
    if (ipc.connected) {
      ipc.send('pty_data', {
        sessionId: loop.sessionInfo.sessionId,
        data,
      });
    }
  });

  if (ipcConnected) {
    // Wire IPC as the IM transport
    loop.setIMTarget('ipc', async (_chatId, text, buttons, event) => {
      ipc.send('notification', {
        text, buttons,
        // Forward the structured event so the bridge renderer can produce
        // a card with proper workspace tag header instead of falling back
        // to plain-text rendering of merged title+body.
        event,
        sessionId: loop.sessionInfo.sessionId,
        workdir,
      });
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

    // IPC message handlers — one per message type.
    // `permission_action` (allow/deny/takeover) routes through SessionManager's
    // SDK path (`handoffToSDK` → `adapter.startRemote`). Only wire it when the
    // adapter advertises `liveSession` support — otherwise the Takeover button
    // would crash a PTY-only provider (Codex) on the first tap.
    if (adapter.capabilities?.liveSession) {
      ipc.on('permission_action', (p: Record<string, unknown>) => {
        loop.handleIMAction(p.action as string, p.toolUseId as string);
      });
    }

    ipc.on('terminal_input', (p: Record<string, unknown>) => {
      // Claude Code TUI uses \r (carriage return) for submit, not \n
      if (p.text) loop.handleTerminalInput(p.text as string + '\r');
    });

    ipc.on('question_answer', (p: Record<string, unknown>) => {
      if (p.answer !== undefined) loop.handleTerminalInput(p.answer as string + '\r');
    });

    ipc.on('config_update', (p: Record<string, unknown>) => {
      if (p.effort) console.error(`  Effort:   ${p.effort}`);
      if (p.model) console.error(`  Model:    ${p.model}`);
    });

    ipc.on('web_input', (p: Record<string, unknown>) => {
      if (p.data) loop.handleTerminalInput(p.data as string);
    });

    ipc.on('reconnected', () => console.error(`  IM:       \x1b[32mreconnected\x1b[0m`));

    console.error(`  IM:       \x1b[32mconnected\x1b[0m (bridge IPC)`);

    // Notify IM that this terminal session is now live, so the user knows
    // where to reply (matches the per-message "↩ Reply here to interact"
    // hint but explicit at session start).
    const projectName = workdir.split('/').filter(Boolean).pop() ?? 'unknown';
    const sessionTag = `${projectName} · #${loop.sessionInfo.sessionId.slice(0, 6)}`;
    ipc.send('notification', {
      text: `🚀 tlive ${adapter.name} started\n${sessionTag}\n\n↩ Reply here to interact`,
      sessionId: loop.sessionInfo.sessionId,
      workdir,
      event: {
        kind: 'activity_text',
        text: `\`${workdir}\``,
        title: `🚀 tlive ${adapter.name} · ${sessionTag}`,
        footer: '↩ Reply here to interact',
      },
    });
  } else {
    console.error(`  IM:       \x1b[33mnot connected\x1b[0m (bridge not running)`);
  }

  // Terminal raw mode
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
    if (ipc.connected) {
      ipc.send('session_unregister', { sessionId: loop.sessionInfo.sessionId });
    }
    ipc.disconnect();
    await loop.stop();
    if (stdin.isTTY) stdin.setRawMode(false);
    exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Show session info
  const info = loop.sessionInfo;
  const localIP = getLocalIP();
  const webUrl = `http://${localIP}:${config.port}/?token=${config.token || info.sessionId.slice(0, 16)}`;
  console.error('');
  console.error(`  \x1b[36m⚡ TLive v1.0 · ${runtimeLabel}\x1b[0m`);
  console.error(`  Session:  ${info.sessionId.slice(0, 8)}...`);
  console.error(`  Workdir:  ${workdir}`);
  console.error(`  Terminal: \x1b[4m${webUrl}\x1b[0m`);

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
