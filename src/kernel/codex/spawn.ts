import { spawn as nodeSpawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandOnPath } from '../integrations/hooks-cleanup.js';

export function codexAppServerSockPath(codexHome?: string): string {
  const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(home, 'app-server-control', 'app-server-control.sock');
}

export interface AppServerCustody {
  adopted: boolean;
  stop: () => void;
}

interface ChildLike {
  pid?: number;
  on: Function;
  kill: Function;
}

const FAST_EXIT_MS = 5000;
const MAX_BACKOFF_MS = 30_000;
const MAX_FAST_EXITS = 6;

function defaultProbe(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect(sockPath);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 1000);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function defaultSpawnFn(logPath: string): ChildLike {
  const fd = openSync(logPath, 'a');
  return nodeSpawn('codex', ['app-server', '--listen', 'unix://'], {
    detached: false,
    stdio: ['ignore', fd, fd],
  });
}

export async function ensureCodexAppServer(opts: {
  logPath: string;
  probe?: (sockPath: string) => Promise<boolean>;
  spawnFn?: (logPath: string) => ChildLike;
  onStateChange?: (s: 'running' | 'degraded') => void;
  platform?: NodeJS.Platform;
  hasCodex?: () => boolean;
}): Promise<AppServerCustody | null> {
  const platform = opts.platform ?? process.platform;
  const hasCodex = opts.hasCodex ?? (() => commandOnPath('codex'));
  if (platform === 'win32' || !hasCodex()) return null;

  const probe = opts.probe ?? defaultProbe;
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  const onStateChange = opts.onStateChange ?? (() => {});

  const sockPath = codexAppServerSockPath();
  const listening = await probe(sockPath);
  if (listening) {
    return { adopted: true, stop: () => {} };
  }

  let stopped = false;
  let fastExitStreak = 0;
  let currentBackoffMs = 1000;
  let respawnTimer: NodeJS.Timeout | undefined;
  let child: ChildLike;

  const scheduleRespawn = () => {
    if (stopped) return;
    if (fastExitStreak >= MAX_FAST_EXITS) {
      onStateChange('degraded');
      return;
    }
    respawnTimer = setTimeout(() => {
      if (stopped) return;
      spawnChild();
    }, currentBackoffMs);
    respawnTimer.unref?.();
    currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
  };

  const spawnChild = () => {
    const spawnedAt = Date.now();
    child = spawnFn(opts.logPath);
    child.on('exit', () => {
      if (stopped) return;
      const lived = Date.now() - spawnedAt;
      if (lived < FAST_EXIT_MS) {
        fastExitStreak += 1;
      } else {
        fastExitStreak = 0;
        currentBackoffMs = 1000;
      }
      scheduleRespawn();
    });
    onStateChange('running');
  };

  spawnChild();

  return {
    adopted: false,
    stop: () => {
      stopped = true;
      if (respawnTimer) clearTimeout(respawnTimer);
      child?.kill?.();
    },
  };
}
